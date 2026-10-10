// Merges partial results from the extraction tiers into one ProductJSON.
// A tier only sets what it actually read from the page; anything left unset becomes null
// and is listed in `missing` (rule 1: never guess).
import type { ProductJSON, SourceMethod } from '@shared/index';

type DataField =
  | 'title'
  | 'brand'
  | 'price'
  | 'rating'
  | 'availability'
  | 'category'
  | 'specs'
  | 'variants'
  | 'images'
  | 'delivery'
  | 'seller'
  | 'sponsored'
  | 'reviews';

/** What one tier found. Every field is optional; null/empty means "not found". */
export type ProductDraft = { nativeId?: string | null } & {
  [K in DataField]?: ProductJSON[K];
};

export interface TierResult {
  method: SourceMethod;
  draft: ProductDraft;
}

const FIELDS: DataField[] = [
  'title',
  'brand',
  'price',
  'rating',
  'availability',
  'category',
  'specs',
  'variants',
  'images',
  'delivery',
  'seller',
  'sponsored',
  'reviews',
];

function present(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

export interface FinalizeContext {
  url: string;
  site: string;
  now: Date;
}

/**
 * Tiers are given fastest-first (jsonld, adapter, llm). A later tier overrides an earlier one
 * field by field, because adapters read what the user actually sees on the live page (prices,
 * stock, delivery). Specs are unioned; for reviews the later tier wins per sub-field.
 */
export function mergeTiers(tiers: TierResult[], ctx: FinalizeContext): ProductJSON | null {
  const merged: ProductDraft = {};
  const fields: Record<string, SourceMethod> = {};
  let nativeId: string | null = null;

  for (const { method, draft } of tiers) {
    if (draft.nativeId) nativeId = draft.nativeId;
    for (const f of FIELDS) {
      const value = draft[f];
      if (!present(value)) continue;
      if (f === 'specs') {
        merged.specs = { ...(merged.specs ?? {}), ...(value as ProductJSON['specs']) };
      } else if (f === 'reviews' && merged.reviews) {
        const prev = merged.reviews;
        const next = value as NonNullable<ProductJSON['reviews']>;
        merged.reviews = {
          basis_count: Math.max(prev.basis_count, next.basis_count),
          summary_text: next.summary_text ?? prev.summary_text,
          insights: next.insights.length ? next.insights : prev.insights,
          histogram: next.histogram ?? prev.histogram,
          items: next.items.length ? next.items : prev.items,
        };
      } else {
        (merged as Record<string, unknown>)[f] = value;
      }
      fields[f] = method;
    }
  }

  if (!nativeId) return null;
  const used = new Set(Object.values(fields));
  // The overall method is the most specific tier that contributed anything.
  const method: SourceMethod = used.has('llm')
    ? 'llm'
    : used.has('adapter')
      ? 'adapter'
      : used.has('serpapi')
        ? 'serpapi'
        : 'jsonld';

  const product: ProductJSON = {
    schema_version: '1.0',
    id: `${ctx.site}:${nativeId}`,
    url: ctx.url,
    site: ctx.site,
    title: merged.title ?? null,
    brand: merged.brand ?? null,
    price: merged.price ?? null,
    rating: merged.rating ?? null,
    availability: merged.availability ?? null,
    category: merged.category ?? null,
    specs: merged.specs ?? {},
    variants: merged.variants ?? null,
    images: merged.images ?? [],
    delivery: merged.delivery ?? null,
    seller: merged.seller ?? null,
    sponsored: merged.sponsored ?? null,
    reviews: merged.reviews ?? null,
    source: { method, extracted_at: ctx.now.toISOString(), fields },
    missing: [],
  };
  product.missing = missingPaths(product);
  return product;
}

export function missingPaths(p: ProductJSON): string[] {
  const missing: string[] = [];
  for (const f of FIELDS) {
    if (f === 'sponsored') continue; // only meaningful on search results
    if (!present(p[f])) missing.push(f);
  }
  if (p.price && p.price.mrp == null) missing.push('price.mrp');
  if (p.availability && p.availability.text == null) missing.push('availability.text');
  if (p.delivery && p.delivery.date == null) missing.push('delivery.date');
  if (p.delivery && p.delivery.cost == null) missing.push('delivery.cost');
  if (p.reviews) {
    if (p.reviews.summary_text == null) missing.push('reviews.summary_text');
    if (p.reviews.histogram == null) missing.push('reviews.histogram');
  }
  return missing;
}
