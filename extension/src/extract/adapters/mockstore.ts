// Adapter for our own mock store (mock-store/, served locally): the backup demo and the only
// place full checkout, cancel and return flows run (docs/safety.md).
import type { PageType, ProductJSON, Variant } from '@shared/index';
import { type OrderDraft, orderStatusFromText } from '../orders';
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

const PAGES: Record<string, PageType> = {
  search: 'search',
  product: 'product',
  cart: 'cart',
  checkout: 'checkout',
  orders: 'orders',
  order: 'order_detail',
};

function isMockStore(doc: Document): boolean {
  return !!doc.querySelector('meta[name="asl-mock-store"]');
}

function availabilityStatus(text: string): NonNullable<ProductJSON['availability']>['status'] {
  if (/only \d+ left/i.test(text)) return 'low_stock';
  if (/unavailable|out of stock/i.test(text)) return 'out_of_stock';
  if (/in stock/i.test(text)) return 'in_stock';
  return 'unknown';
}

function product(doc: Document, url: string, now: Date): ProductDraft {
  if (!isMockStore(doc)) return {};
  const draft: ProductDraft = { nativeId: new URL(url).searchParams.get('id') };
  draft.title = textOf(doc.querySelector('#title'));
  draft.brand = textOf(doc.querySelector('#brand'));
  const amount = parseMoney(textOf(doc.querySelector('#price')));
  if (amount != null) {
    const mrp = parseMoney(textOf(doc.querySelector('#mrp')));
    draft.price = { amount, currency: 'INR', mrp: mrp != null && mrp >= amount ? mrp : null };
  }
  const avail = textOf(doc.querySelector('#availability'));
  if (avail) draft.availability = { status: availabilityStatus(avail), text: avail };
  const delivery = textOf(doc.querySelector('#delivery'));
  if (delivery) {
    draft.delivery = {
      text: delivery,
      cost: /^free/i.test(delivery) ? { amount: 0, currency: 'INR' } : null,
      date: parseDayMonth(delivery, now),
    };
  }
  draft.seller = textOf(doc.querySelector('#seller'));
  const crumbs = Array.from(doc.querySelectorAll('#breadcrumbs a'))
    .map((a) => textOf(a))
    .filter((t): t is string => !!t);
  if (crumbs.length) draft.category = crumbs.join(' > ');
  const specs: ProductJSON['specs'] = {};
  for (const tr of Array.from(doc.querySelectorAll('table.specs tr'))) {
    addSpec(
      specs,
      tr.querySelector('th')?.textContent ?? '',
      tr.querySelector('td')?.textContent ?? '',
    );
  }
  draft.specs = specs;
  const variants: Variant[] = Array.from(doc.querySelectorAll('#colour-swatches .swatch')).map(
    (b) => ({
      name: 'Colour',
      value: b.getAttribute('data-colour') ?? textOf(b) ?? '',
      selected: b.getAttribute('aria-pressed') === 'true',
      available: true,
      target_id: targetIdFor(b),
    }),
  );
  draft.variants = variants.filter((v) => v.value);
  return draft;
}

function searchResults(doc: Document, url: string, now: Date): ProductJSON[] {
  const site = siteOf(url);
  const out: ProductJSON[] = [];
  for (const card of Array.from(doc.querySelectorAll('li.result[data-product-id]'))) {
    const id = card.getAttribute('data-product-id');
    const link = card.querySelector('h2 a');
    const href = absoluteUrl(link?.getAttribute('href'), url);
    if (!id || !href) continue;
    const draft: ProductDraft = { nativeId: id, title: textOf(link), sponsored: false };
    const amount = parseMoney(textOf(card.querySelector('.price')));
    if (amount != null) {
      const mrp = parseMoney(textOf(card.querySelector('.mrp')));
      draft.price = { amount, currency: 'INR', mrp: mrp != null && mrp >= amount ? mrp : null };
    }
    const rating = card.querySelector('.rating')?.getAttribute('aria-label') ?? '';
    const m = rating.match(/^([\d.]+) out of 5 stars, ([\d,]+) ratings/);
    if (m?.[1] && m[2]) draft.rating = { value: Number(m[1]), count: parseCount(m[2]) ?? 0 };
    const stock = textOf(card.querySelector('.in-stock, .low-stock, .out-of-stock'));
    if (stock) draft.availability = { status: availabilityStatus(stock), text: stock };
    const p = mergeTiers([{ method: 'adapter', draft }], { url: href, site, now });
    if (p) out.push(p);
  }
  return out;
}

function orders(doc: Document, url: string): OrderDraft[] {
  if (!isMockStore(doc)) return [];
  const out: OrderDraft[] = [];
  for (const el of Array.from(doc.querySelectorAll('article.order[data-order-id]'))) {
    const realId = el.getAttribute('data-order-id');
    if (!realId) continue;
    const actions = Array.from(el.querySelectorAll('[data-action]')).flatMap((b) => {
      const action = b.getAttribute('data-action');
      return action === 'track' || action === 'return' || action === 'cancel'
        ? [{ action, el: b } as const]
        : [];
    });
    const date = (sel: string): string | null =>
      clean(el.querySelector(`${sel} time`)?.getAttribute('datetime'))?.slice(0, 10) ?? null;
    out.push({
      realId,
      items: Array.from(el.querySelectorAll('.order-item')).map((li) => {
        const a = li.querySelector('.item-title');
        const amount = parseMoney(textOf(li.querySelector('.item-price')));
        return {
          title: textOf(a) ?? '',
          quantity: Math.max(1, parseCount(textOf(li.querySelector('.item-qty'))) ?? 1),
          price: amount != null ? { amount, currency: 'INR' } : null,
          product_url: absoluteUrl(a?.getAttribute('href'), url),
        };
      }),
      status: orderStatusFromText(textOf(el.querySelector('.order-status'))),
      dates: {
        ordered: date('.order-date'),
        expected_delivery: date('.order-expected'),
        delivered: date('.order-delivered'),
      },
      available_actions: actions.map((a) => a.action),
      actionElements: actions,
    });
  }
  return out;
}

export const mockStoreAdapter: SiteAdapter = {
  matches: (site) => site === 'localhost' || site === '127.0.0.1',
  pageType: (_url, doc) =>
    isMockStore(doc) ? (PAGES[doc.body?.getAttribute('data-page') ?? ''] ?? 'other') : null,
  product,
  searchResults,
  orders,
};
