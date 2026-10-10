// Flipkart adapter. Flipkart's class names are generated and change between deploys, so this
// adapter reads structure and visible wording (label/value pairs, "Seller:", "Delivery by", the
// ₹ amount after the title), never class names. Checked against fixtures/pages/flipkart-*.html.
import type { AvailabilityStatus, PageType, ProductJSON, Variant } from '@shared/index';
import { mergeTiers, type ProductDraft } from '../product';
import { targetIdFor } from '../targets';
import {
  absoluteUrl,
  addSpec,
  clean,
  parseCount,
  parseDayMonth,
  parseMoney,
  siteOf,
  textOf,
} from '../util';
import type { SiteAdapter } from './types';

function pageType(url: string): PageType | null {
  const path = new URL(url).pathname;
  if (/\/product-reviews\//.test(path)) return 'reviews';
  if (/\/p\/itm/.test(path)) return 'product';
  if (path.startsWith('/search')) return 'search';
  if (path.startsWith('/viewcart')) return 'cart';
  if (path.startsWith('/checkout')) return 'checkout';
  if (/\/account\/order_details/.test(path)) return 'order_detail';
  if (/\/account\/orders/.test(path)) return 'orders';
  return null;
}

/** Elements with no element children and some text, in document order. */
function leaves(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll('div, span, h1, h2, a, li, td')).filter(
    (e) => e.children.length === 0 && clean(e.textContent) != null,
  );
}

function after(a: Node, b: Node): boolean {
  return (a.compareDocumentPosition(b) & 4) !== 0; // DOCUMENT_POSITION_FOLLOWING
}

const RUPEES = /^₹\s?[\d,]+(?:\.\d+)?$/;

function priceNearTitle(doc: Document, all: Element[]): ProductJSON['price'] {
  const h1 = doc.querySelector('h1');
  if (!h1) return null;
  const i = all.findIndex((e) => after(h1, e) && RUPEES.test(clean(e.textContent) ?? ''));
  const el = all[i];
  if (!el) return null;
  const amount = parseMoney(el.textContent);
  if (amount == null) return null;
  // The struck-through MRP is a plain number just before the price in the same price block.
  let mrp: number | null = null;
  for (const sib of Array.from(
    el.parentElement?.parentElement?.querySelectorAll('div, span') ?? [],
  )) {
    const t = clean(sib.textContent) ?? '';
    if (sib.children.length === 0 && /^₹?\s?[\d,]+$/.test(t) && sib !== el) {
      const n = parseMoney(t);
      if (n != null && n > amount) mrp = n;
    }
  }
  return { amount, currency: 'INR', mrp };
}

function specs(doc: Document): ProductJSON['specs'] {
  const out: ProductJSON['specs'] = {};
  // Current layout: a row is <div><div font="…-m">Label</div><div font="s">Value</div>…</div>.
  for (const label of Array.from(doc.querySelectorAll('[font="default-fk-font-m"]'))) {
    const value = label.nextElementSibling;
    if (label.children.length || !value || value.children.length) continue;
    if (value.getAttribute('font') !== 's') continue;
    addSpec(out, label.textContent ?? '', value.textContent ?? '');
  }
  // Older layout: specification tables with td/li pairs.
  for (const tr of Array.from(doc.querySelectorAll('table tr'))) {
    const cells = Array.from(tr.children);
    if (cells.length === 2) addSpec(out, cells[0]?.textContent ?? '', cells[1]?.textContent ?? '');
  }
  return out;
}

function variants(all: Element[], pid: string | null): Variant[] {
  const out: Variant[] = [];
  for (const label of all) {
    const m = clean(label.textContent)?.match(/^(?:Selected )?([A-Za-z][A-Za-z ]{1,20}):$/);
    if (!m || !m[1]) continue;
    const name = m[1];
    const selectedValue = textOf(label.nextElementSibling);
    if (!selectedValue) continue;
    // The options are product links in the same group; walk up until the group holds some.
    let group: Element | null = label.parentElement;
    for (let i = 0; i < 4 && group && !group.querySelector('a[href*="/p/"]'); i++) {
      group = group.parentElement;
    }
    const links = Array.from(group?.querySelectorAll('a[href*="/p/"]') ?? []);
    if (!links.length) continue; // a "Label: value" line that isn't a variant picker
    const seen = new Set<string>();
    for (const a of links) {
      // Image-only options (colour photos) carry no name on the page; only the current one
      // can be named, from the "Selected Color:" line. Others are skipped, never guessed.
      const isCurrent =
        !!pid && new URL(a.getAttribute('href') ?? '', 'https://x').searchParams.get('pid') === pid;
      const value = textOf(a.querySelector('div, span')) ?? (isCurrent ? selectedValue : null);
      if (!value || RUPEES.test(value) || seen.has(value)) continue;
      seen.add(value);
      out.push({
        name,
        value,
        selected: value === selectedValue,
        available: null,
        target_id: targetIdFor(a),
      });
    }
    if (!seen.has(selectedValue)) {
      out.push({ name, value: selectedValue, selected: true, available: true, target_id: null });
    }
  }
  return out;
}

function availability(all: Element[]): ProductJSON['availability'] {
  const rules: [RegExp, AvailabilityStatus][] = [
    [/^(sold out|out of stock|currently unavailable)/i, 'out_of_stock'],
    [/^(only \d+ left|hurry, only)/i, 'low_stock'],
    [/^(coming soon|pre-?order)/i, 'preorder'],
  ];
  for (const e of all) {
    const t = clean(e.textContent) ?? '';
    for (const [re, status] of rules) if (re.test(t)) return { status, text: t };
  }
  return null;
}

function product(doc: Document, url: string, now: Date): ProductDraft {
  const all = leaves(doc);
  const draft: ProductDraft = {};
  draft.nativeId = new URL(url).searchParams.get('pid');
  draft.title = textOf(doc.querySelector('h1'));
  draft.price = priceNearTitle(doc, all);
  draft.availability = availability(all);

  for (const e of all) {
    const t = clean(e.textContent) ?? '';
    const seller = t.match(/^(?:Seller|Sold by):\s*(.+)$/i);
    if (seller?.[1] && !draft.seller) draft.seller = seller[1];
    if (/^Delivery by$/i.test(t) && !draft.delivery) {
      const when = textOf(e.nextElementSibling);
      if (when)
        draft.delivery = {
          text: `Delivery by ${when}`,
          cost: null,
          date: parseDayMonth(when, now),
        };
    }
  }

  draft.specs = specs(doc);
  draft.variants = variants(all, draft.nativeId ?? null);
  return draft;
}

function searchResults(doc: Document, url: string, now: Date): ProductJSON[] {
  const site = siteOf(url);
  const out: ProductJSON[] = [];
  for (const card of Array.from(doc.querySelectorAll('[data-id]'))) {
    const pid = card.getAttribute('data-id');
    const link = card.querySelector('a[href*="/p/"]');
    const href = absoluteUrl(link?.getAttribute('href'), url);
    if (!pid || !href || out.some((p) => p.id === `${site}:${pid}`)) continue;
    const productUrl = new URL(href);
    productUrl.search = `?pid=${pid}`;

    const draft: ProductDraft = { nativeId: pid };
    const img = card.querySelector('img[alt]');
    draft.title =
      clean(card.querySelector('a[title]')?.getAttribute('title')) ??
      clean(img?.getAttribute('alt'));
    const src = img?.getAttribute('src');
    if (src && !src.startsWith('data:')) {
      draft.images = [
        {
          url: absoluteUrl(src, url) ?? src,
          alt: clean(img?.getAttribute('alt')),
          description: null,
          ocr_text: null,
        },
      ];
    }

    const cardLeaves = leaves(card);
    const amounts = cardLeaves.filter((e) => RUPEES.test(clean(e.textContent) ?? ''));
    const amount = parseMoney(amounts[0]?.textContent);
    if (amount != null) {
      const next = amounts[1];
      const mrp =
        next && next.parentElement === amounts[0]?.parentElement
          ? parseMoney(next.textContent)
          : null;
      draft.price = { amount, currency: 'INR', mrp: mrp != null && mrp > amount ? mrp : null };
    }

    const ratingEl = card.querySelector('[id^="productRating_"]');
    const value = parseMoney(textOf(ratingEl));
    const countText = cardLeaves
      .map((e) => clean(e.textContent) ?? '')
      .find((t) => /^\([\d,]+\)$/.test(t) || /^[\d,]+ Ratings/i.test(t));
    const count = parseCount(countText);
    if (value != null && value <= 5 && count != null) draft.rating = { value, count };

    draft.sponsored = cardLeaves.some((e) => /^(Sponsored|Ad)$/i.test(clean(e.textContent) ?? ''));
    const p = mergeTiers([{ method: 'adapter', draft }], { url: productUrl.href, site, now });
    if (p && p.title) out.push(p);
  }
  return out;
}

export const flipkartAdapter: SiteAdapter = {
  matches: (site) => /(^|\.)flipkart\.com$/.test(site),
  pageType: (url) => pageType(url),
  product,
  searchResults,
};
