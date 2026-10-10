// Tier 1: schema.org JSON-LD and Open Graph / product meta tags. Fast and site-independent.
import type { AvailabilityStatus, ProductJSON, ReviewItem } from '@shared/index';
import type { ProductDraft } from './product';
import { absoluteUrl, addSpec, clean, parseCount, parseMoney } from './util';

type Node = Record<string, unknown>;

/** Every JSON-LD node on the page, flattening arrays and @graph. Bad blocks are skipped. */
export function jsonLdNodes(doc: Document): Node[] {
  const out: Node[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== 'object') return;
    const node = v as Node;
    out.push(node);
    if (Array.isArray(node['@graph'])) visit(node['@graph']);
  };
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      visit(JSON.parse(s.textContent ?? ''));
    } catch {
      // Malformed JSON-LD is common; the next tier covers it.
    }
  }
  return out;
}

export function hasType(node: Node, type: string): boolean {
  const t = node['@type'];
  return Array.isArray(t) ? t.includes(type) : t === type;
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return clean(v);
  if (typeof v === 'number') return String(v);
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') return parseMoney(v);
  return null;
}

function first<T>(v: T | T[] | undefined): T | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function nameOf(v: unknown): string | null {
  const n = first(v as Node | Node[] | string);
  if (typeof n === 'string') return clean(n);
  if (n && typeof n === 'object') return str((n as Node).name);
  return null;
}

const AVAILABILITY: Record<string, AvailabilityStatus> = {
  instock: 'in_stock',
  instoreonly: 'in_stock',
  onlineonly: 'in_stock',
  limitedavailability: 'low_stock',
  outofstock: 'out_of_stock',
  soldout: 'out_of_stock',
  discontinued: 'out_of_stock',
  preorder: 'preorder',
  presale: 'preorder',
  backorder: 'preorder',
};

export function availabilityFromSchema(v: unknown): AvailabilityStatus {
  const s = str(v)?.split('/').pop()?.toLowerCase() ?? '';
  return AVAILABILITY[s] ?? 'unknown';
}

function isoDate(v: unknown): string | null {
  const s = str(v);
  const m = s?.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

function images(v: unknown, base: string): ProductJSON['images'] {
  const list = Array.isArray(v) ? v : v == null ? [] : [v];
  const out: ProductJSON['images'] = [];
  for (const item of list) {
    const raw = typeof item === 'string' ? item : str((item as Node | null)?.url);
    const url = absoluteUrl(raw, base);
    if (url && !out.some((i) => i.url === url)) {
      out.push({ url, alt: null, description: null, ocr_text: null });
    }
  }
  return out;
}

/** Reads the first schema.org Product on the page. Returns an empty draft if there is none. */
export function productFromJsonLd(doc: Document, url: string): ProductDraft {
  const product = jsonLdNodes(doc).find((n) => hasType(n, 'Product'));
  if (!product) return {};
  const draft: ProductDraft = {};

  draft.nativeId = str(product.sku) ?? str(product.productID) ?? str(product.mpn);
  draft.title = str(product.name);
  draft.brand = nameOf(product.brand);
  draft.category = str(product.category);
  draft.images = images(product.image, url);

  const offer = first(product.offers as Node | Node[] | undefined);
  if (offer) {
    const amount = num(offer.price) ?? num(offer.lowPrice);
    const currency = str(offer.priceCurrency)?.toUpperCase() ?? null;
    if (amount != null && currency && /^[A-Z]{3}$/.test(currency)) {
      let mrp: number | null = null;
      const specsList = offer.priceSpecification;
      for (const ps of (Array.isArray(specsList) ? specsList : [specsList]) as Node[]) {
        if (ps && /ListPrice|StrikethroughPrice/i.test(str(ps.priceType) ?? ''))
          mrp = num(ps.price);
      }
      draft.price = { amount, currency, mrp: mrp != null && mrp >= amount ? mrp : null };
    }
    if (offer.availability != null) {
      draft.availability = { status: availabilityFromSchema(offer.availability), text: null };
    }
    draft.seller = nameOf(offer.seller);
  }

  const agg = product.aggregateRating as Node | undefined;
  if (agg) {
    const value = num(agg.ratingValue);
    const best = num(agg.bestRating) ?? 5;
    const count = parseCount(str(agg.ratingCount) ?? str(agg.reviewCount));
    if (value != null && best > 0 && count != null) {
      draft.rating = { value: Math.round((value / best) * 5 * 100) / 100, count };
    }
  }

  const specs: ProductJSON['specs'] = {};
  const colour = str(product.color);
  if (colour) addSpec(specs, 'Colour', colour);
  const props = product.additionalProperty;
  for (const p of (Array.isArray(props) ? props : []) as Node[]) {
    const label = str(p?.name);
    const value = str(p?.value);
    if (label && value) addSpec(specs, label, [value, str(p.unitText)].filter(Boolean).join(' '));
  }
  draft.specs = specs;

  const reviews = Array.isArray(product.review) ? (product.review as Node[]) : [];
  const items: ReviewItem[] = [];
  for (const r of reviews) {
    const text = str(r.reviewBody) ?? str(r.description);
    if (!text) continue;
    const rr = r.reviewRating as Node | undefined;
    const value = num(rr?.ratingValue);
    const best = num(rr?.bestRating) ?? 5;
    items.push({
      rating: value != null && best > 0 ? (value / best) * 5 : null,
      title: str(r.name),
      text,
      date: isoDate(r.datePublished),
      verified: null,
    });
  }
  if (items.length) {
    draft.reviews = {
      basis_count: items.length,
      summary_text: null,
      insights: [],
      histogram: null,
      items,
    };
  }
  return draft;
}

function meta(doc: Document, name: string): string | null {
  const el = doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
  return clean(el?.getAttribute('content'));
}

/** Open Graph / product meta tags: title, image and price when the page declares them. */
export function productFromMeta(doc: Document, url: string): ProductDraft {
  const draft: ProductDraft = {};
  const ogType = meta(doc, 'og:type');
  const amount = parseMoney(meta(doc, 'product:price:amount') ?? meta(doc, 'og:price:amount'));
  const currency = (
    meta(doc, 'product:price:currency') ?? meta(doc, 'og:price:currency')
  )?.toUpperCase();
  if (!/product/i.test(ogType ?? '') && amount == null) return draft;
  draft.title = meta(doc, 'og:title');
  draft.images = images(meta(doc, 'og:image'), url);
  if (amount != null && currency && /^[A-Z]{3}$/.test(currency)) {
    draft.price = { amount, currency, mrp: null };
  }
  draft.nativeId = meta(doc, 'product:retailer_item_id');
  return draft;
}
