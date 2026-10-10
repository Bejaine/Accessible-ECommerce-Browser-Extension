// Amazon.in adapter: reads the product page and search result cards from the live DOM.
// Selectors are checked against fixtures/pages/amazon-*.html.
import type {
  Delivery,
  PageType,
  ProductJSON,
  ReviewInsight,
  ReviewItem,
  Sentiment,
  Variant,
} from '@shared/index';
import { mergeTiers, type ProductDraft } from '../product';
import { targetIdFor } from '../targets';
import {
  addSpec,
  clean,
  parseCount,
  parseDayMonth,
  parseMoney,
  siteOf,
  spacedText,
  textOf,
} from '../util';
import type { SiteAdapter } from './types';

const ASIN_IN_URL = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/;

function currencyOf(text: string | null): string {
  return text && /\$/.test(text) ? 'USD' : 'INR';
}

/** Amazon sprinkles LRM/RLM marks and "‎:" into labels. */
function tidy(text: string | null): string | null {
  return clean(text?.replace(/[‎‏]/g, '') ?? null);
}

function first(root: ParentNode, selectors: string[]): Element | null {
  for (const s of selectors) {
    for (const el of Array.from(root.querySelectorAll(s))) {
      if (clean(el.textContent)) return el;
    }
  }
  return null;
}

function pageType(url: string): PageType | null {
  const path = new URL(url).pathname;
  if (ASIN_IN_URL.test(path)) return 'product';
  if (path.startsWith('/s') && /[?&]k=/.test(url)) return 'search';
  if (/\/product-reviews\//.test(path)) return 'reviews';
  if (/\/gp\/cart\//.test(path) || path.startsWith('/cart')) return 'cart';
  if (/\/gp\/buy\/|\/checkout\//.test(path)) return 'checkout';
  if (/order-details|\/gp\/your-account\/order-details/.test(path)) return 'order_detail';
  if (/order-history|\/your-orders/.test(path)) return 'orders';
  return null;
}

function availabilityStatus(text: string): NonNullable<ProductJSON['availability']>['status'] {
  if (/only \d+ left|few left/i.test(text)) return 'low_stock';
  if (/currently unavailable|out of stock|unavailable/i.test(text)) return 'out_of_stock';
  if (/pre-?order|releases? on|will be released/i.test(text)) return 'preorder';
  if (/in stock|available/i.test(text)) return 'in_stock';
  return 'unknown';
}

function deliveryFrom(el: Element | null, now: Date): Delivery | null {
  if (!el) return null;
  const text = tidy(el.textContent)?.replace(/\s*Details\s*$/, '') ?? null;
  if (!text) return null;
  const priceAttr = el.getAttribute('data-csa-c-delivery-price');
  let cost: Delivery['cost'] = null;
  if (priceAttr && /^free$/i.test(priceAttr.trim())) cost = { amount: 0, currency: 'INR' };
  else if (priceAttr && /\d/.test(priceAttr)) {
    const amount = parseMoney(priceAttr);
    if (amount != null) cost = { amount, currency: currencyOf(priceAttr) };
  } else if (/^free delivery/i.test(text)) cost = { amount: 0, currency: 'INR' };
  const date = parseDayMonth(el.getAttribute('data-csa-c-delivery-time') ?? text, now);
  return { text, cost, date };
}

function specs(doc: Document): ProductJSON['specs'] {
  const out: ProductJSON['specs'] = {};
  // "Product overview" table near the title.
  for (const tr of Array.from(doc.querySelectorAll('#productOverview_feature_div tr'))) {
    const [l, v] = Array.from(tr.querySelectorAll('td'));
    addSpec(out, tidy(l?.textContent ?? null) ?? '', tidy(v?.textContent ?? null) ?? '');
  }
  // "Technical details" / "Additional information" tables.
  for (const tr of Array.from(doc.querySelectorAll('#prodDetails tr'))) {
    const label = tidy(tr.querySelector('th')?.textContent ?? null);
    if (!label || /customer reviews|best sellers rank/i.test(label)) continue;
    addSpec(out, label, tidy(tr.querySelector('td')?.textContent ?? null) ?? '');
  }
  // Older "Product details" bullet list.
  for (const li of Array.from(doc.querySelectorAll('#detailBullets_feature_div li'))) {
    const bold = li.querySelector('.a-text-bold');
    const label = tidy(bold?.textContent ?? null)?.replace(/\s*:$/, '');
    if (!label || /customer reviews|best sellers rank/i.test(label)) continue;
    addSpec(out, label, tidy(bold?.nextElementSibling?.textContent ?? null) ?? '');
  }
  return out;
}

/** "https://…/I/31w8ruMm+AL._SS40_.jpg" → "https://…/I/31w8ruMm+AL.jpg" (full size). */
function fullSize(src: string): string {
  return src.replace(/\._[^/]*_\./, '.');
}

function images(doc: Document): ProductJSON['images'] {
  const out: ProductJSON['images'] = [];
  const add = (url: string | null | undefined, alt: string | null): void => {
    if (!url || url.startsWith('data:') || out.some((i) => i.url === url)) return;
    out.push({ url, alt, description: null, ocr_text: null });
  };
  const main = doc.querySelector('#landingImage, #imgBlkFront');
  if (main) {
    add(
      main.getAttribute('data-old-hires') || main.getAttribute('src'),
      clean(main.getAttribute('alt')),
    );
  }
  for (const img of Array.from(doc.querySelectorAll('#altImages li.imageThumbnail img'))) {
    const src = img.getAttribute('src');
    if (src) add(fullSize(src), null);
  }
  return out.slice(0, 10);
}

function variants(doc: Document): Variant[] {
  const out: Variant[] = [];
  for (const row of Array.from(doc.querySelectorAll('[id^="inline-twister-row-"]'))) {
    const dim = row.id.replace('inline-twister-row-', '');
    const name =
      tidy(
        row.querySelector(`#inline-twister-dim-title-${dim} .a-color-secondary`)?.textContent ??
          null,
      )?.replace(/:$/, '') ?? dim.replace(/_name$/, '').replace(/_/g, ' ');
    const seen = new Set<string>();
    for (const li of Array.from(row.querySelectorAll('li[data-asin]'))) {
      const value =
        clean(li.querySelector('img[alt]')?.getAttribute('alt')) ??
        textOf(li.querySelector('.swatch-title-text-display')) ??
        textOf(li.querySelector('.a-button-text'));
      if (!value || seen.has(value)) continue;
      seen.add(value);
      const control = li.querySelector('input, button, a[href]');
      out.push({
        name,
        value,
        selected: li.getAttribute('data-initiallyselected') === 'true',
        available: li.getAttribute('data-initiallyunavailable') === 'true' ? false : true,
        target_id: control ? targetIdFor(control) : null,
      });
    }
  }
  return out;
}

function reviews(doc: Document, ratingCount: number | null, now: Date): ProductJSON['reviews'] {
  const summary = textOf(doc.querySelector('[data-testid="overall-summary"]'));

  // Sentiment per aspect comes from the tab labels: "Positive aspect, value for money, 66 mentions".
  const sentimentByTopic = new Map<string, Sentiment>();
  for (const tab of Array.from(doc.querySelectorAll('[role="tab"][aria-label*="aspect"]'))) {
    const m = tab
      .getAttribute('aria-label')
      ?.match(/^(positive|negative|mixed) aspect, (.+?), \d/i);
    if (m && m[1] && m[2])
      sentimentByTopic.set(m[2].toLowerCase(), m[1].toLowerCase() as Sentiment);
  }
  const insights: ReviewInsight[] = [];
  for (const el of Array.from(
    doc.querySelectorAll('[data-testid="mentions-inline"] > span:first-child'),
  )) {
    const m = clean(el.textContent)?.match(
      /^([\d,]+) customers mention (.+?), ([\d,]+) positive, ([\d,]+) negative/i,
    );
    if (!m || !m[1] || !m[2] || !m[3] || !m[4]) continue;
    const topic = m[2];
    if (insights.some((i) => i.topic.toLowerCase() === topic.toLowerCase())) continue;
    insights.push({
      topic: topic.charAt(0).toUpperCase() + topic.slice(1),
      sentiment: sentimentByTopic.get(topic.toLowerCase()) ?? 'mixed',
      mentions: {
        total: parseCount(m[1]) ?? 0,
        positive: parseCount(m[3]) ?? 0,
        negative: parseCount(m[4]) ?? 0,
      },
    });
  }

  // Amazon shows the histogram as percentages; counts are derived from the page's own rating
  // count (see docs/decisions.md), so they are only as exact as Amazon's rounding.
  let histogram: NonNullable<ProductJSON['reviews']>['histogram'] = null;
  const pct: Record<string, number> = {};
  for (const a of Array.from(doc.querySelectorAll('#histogramTable [aria-label]'))) {
    const m = a.getAttribute('aria-label')?.match(/(\d+) percent of reviews have (\d) star/);
    if (m && m[1] && m[2]) pct[m[2]] = Number(m[1]);
  }
  if (ratingCount != null && ['1', '2', '3', '4', '5'].every((k) => k in pct)) {
    const count = (k: string): number => Math.round(((pct[k] ?? 0) * ratingCount) / 100);
    histogram = {
      '1': count('1'),
      '2': count('2'),
      '3': count('3'),
      '4': count('4'),
      '5': count('5'),
    };
  }

  const items: ReviewItem[] = [];
  const seen = new Set<string>();
  for (const r of Array.from(doc.querySelectorAll('[data-hook="review"]'))) {
    if (r.id && seen.has(r.id)) continue;
    if (r.id) seen.add(r.id);
    const body = r.querySelector(
      '[data-hook="reviewRichContentContainer"], [data-hook="review-body"]',
    );
    const text = body
      ? (clean(
          Array.from(body.querySelectorAll('p, span'))
            .filter((e) => !e.querySelector('p, span'))
            .map((e) => e.textContent ?? '')
            .join(' '),
        ) ?? textOf(body))
      : null;
    if (!text) continue;
    const stars = textOf(
      r.querySelector(
        '[data-hook="review-star-rating"] .a-icon-alt, [data-hook="cmps-review-star-rating"] .a-icon-alt',
      ),
    );
    const ratingMatch = stars?.match(/^([\d.]+) out of 5/);
    items.push({
      rating: ratingMatch?.[1] ? Number(ratingMatch[1]) : null,
      title: textOf(
        r.querySelector('[data-hook="reviewTitle"], [data-hook="review-title"] > span:last-child'),
      ),
      text,
      date: parseDayMonth(textOf(r.querySelector('[data-hook="review-date"]')), now),
      verified: r.querySelector('[data-hook="avp-badge"]') ? true : null,
    });
  }

  if (!summary && !insights.length && !histogram && !items.length) return null;
  return { basis_count: items.length, summary_text: summary, insights, histogram, items };
}

function brand(doc: Document): string | null {
  const overview = tidy(
    doc.querySelector('#productOverview_feature_div tr.po-brand td:last-child')?.textContent ??
      null,
  );
  if (overview) return overview;
  const byline = tidy(doc.querySelector('#bylineInfo')?.textContent ?? null);
  const m = byline?.match(/^Visit the (.+?) Store$/i) ?? byline?.match(/^Brand:\s*(.+)$/i);
  return m?.[1] ?? null;
}

function product(doc: Document, url: string, now: Date): ProductDraft {
  const draft: ProductDraft = {};
  draft.nativeId =
    new URL(url).pathname.match(ASIN_IN_URL)?.[1] ??
    clean(doc.querySelector<HTMLInputElement>('input#ASIN')?.getAttribute('value'));
  draft.title = textOf(doc.querySelector('span#productTitle'));
  draft.brand = brand(doc);

  const priceEl = first(doc, [
    '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen',
    '#corePriceDisplay_desktop_feature_div .priceToPay .a-price-whole',
    '#corePrice_feature_div .a-price .a-offscreen',
    '#corePrice_desktop .a-price .a-offscreen',
  ]);
  const amount = parseMoney(priceEl?.textContent);
  if (amount != null) {
    const mrpEl = first(doc, [
      '#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen',
      '#corePrice_desktop .a-text-price .a-offscreen',
    ]);
    const mrp = parseMoney(mrpEl?.textContent);
    draft.price = {
      amount,
      currency: currencyOf(priceEl?.textContent ?? null),
      mrp: mrp != null && mrp >= amount ? mrp : null,
    };
  }

  const popover = doc.querySelector('#acrPopover');
  const value = parseMoney(popover?.getAttribute('title') ?? textOf(popover));
  const reviewText = doc.querySelector('#acrCustomerReviewText');
  const count = parseCount(reviewText?.getAttribute('aria-label') ?? textOf(reviewText));
  if (value != null && value <= 5 && count != null) draft.rating = { value, count };

  // With several buying options (accordion rows), the active row is what "Add to cart" buys;
  // the first match in document order is the default row when the active one can't be scoped.
  const active = doc.querySelector('#buybox .a-accordion-active');
  const inBuybox = (selector: string): Element | null =>
    active?.querySelector(selector) ?? doc.querySelector(selector);
  const avail = textOf(
    inBuybox('#availability .primary-availability-message') ?? inBuybox('#availability > span'),
  );
  if (avail) draft.availability = { status: availabilityStatus(avail), text: avail };
  else if (doc.querySelector('#outOfStock')) {
    draft.availability = {
      status: 'out_of_stock',
      text: textOf(doc.querySelector('#outOfStock .a-color-price')),
    };
  }

  draft.delivery = deliveryFrom(
    inBuybox('#mir-layout-DELIVERY_BLOCK [data-csa-c-delivery-time]'),
    now,
  );
  draft.seller =
    textOf(inBuybox('#sellerProfileTriggerId')) ??
    textOf(inBuybox('#merchantInfoFeature_feature_div .offer-display-feature-text-message'));

  const crumbs = Array.from(doc.querySelectorAll('#wayfinding-breadcrumbs_feature_div li a'))
    .map((a) => textOf(a))
    .filter((t): t is string => !!t);
  draft.category = crumbs.length ? crumbs.join(' > ') : null;

  draft.specs = specs(doc);
  draft.images = images(doc);
  draft.variants = variants(doc);
  draft.reviews = reviews(doc, count, now);
  return draft;
}

function searchResults(doc: Document, url: string, now: Date): ProductJSON[] {
  const site = siteOf(url);
  const origin = new URL(url).origin;
  const out: ProductJSON[] = [];
  for (const card of Array.from(
    doc.querySelectorAll('[data-component-type="s-search-result"][data-asin]'),
  )) {
    const asin = card.getAttribute('data-asin');
    if (!asin || out.some((p) => p.id === `${site}:${asin}`)) continue;
    const draft: ProductDraft = { nativeId: asin };
    draft.title = textOf(card.querySelector('h2'));
    const priceText = textOf(
      card.querySelector('[data-cy="price-recipe"] .a-price:not(.a-text-price) .a-offscreen'),
    );
    const amount = parseMoney(priceText);
    if (amount != null) {
      const mrp = parseMoney(
        textOf(card.querySelector('[data-cy="price-recipe"] .a-price.a-text-price .a-offscreen')),
      );
      draft.price = {
        amount,
        currency: currencyOf(priceText),
        mrp: mrp != null && mrp >= amount ? mrp : null,
      };
    }
    const stars = textOf(card.querySelector('[data-cy="reviews-block"] .a-icon-alt'));
    const ratings = Array.from(card.querySelectorAll('[data-cy="reviews-block"] [aria-label]'))
      .map((e) => e.getAttribute('aria-label') ?? '')
      .find((l) => /ratings?$/i.test(l));
    const value = stars ? parseMoney(stars) : null;
    const count = parseCount(ratings);
    if (value != null && value <= 5 && count != null) draft.rating = { value, count };
    const deliveryRow = card.querySelector(
      '[data-cy="delivery-recipe"] .a-row, [data-cy="delivery-recipe"]',
    );
    // The block can hold a second "Or fastest delivery …" line; keep the standard one.
    const deliveryText = clean(spacedText(deliveryRow)?.replace(/\s*Or fastest delivery.*$/i, ''));
    if (deliveryText) {
      draft.delivery = {
        text: deliveryText,
        cost: /^free delivery/i.test(deliveryText) ? { amount: 0, currency: 'INR' } : null,
        date: parseDayMonth(deliveryText, now),
      };
    }
    const img = card.querySelector('img.s-image');
    const src = img?.getAttribute('src');
    if (src) {
      draft.images = [
        {
          url: src,
          alt: clean(img?.getAttribute('alt')?.replace(/^Sponsored Ad - /, '')),
          description: null,
          ocr_text: null,
        },
      ];
    }
    draft.sponsored =
      !!card.querySelector('.puis-sponsored-label-text') || card.classList.contains('AdHolder');
    const p = mergeTiers([{ method: 'adapter', draft }], {
      url: `${origin}/dp/${asin}`,
      site,
      now,
    });
    if (p && p.title) out.push(p);
  }
  return out;
}

export const amazonAdapter: SiteAdapter = {
  matches: (site) => /(^|\.)amazon\.(in|com)$/.test(site),
  pageType: (url) => pageType(url),
  product,
  searchResults,
};
