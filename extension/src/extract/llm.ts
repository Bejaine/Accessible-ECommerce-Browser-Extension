// Tier 3: LLM-fallback extraction (POST /extract/fallback) when JSON-LD and the site adapter
// leave key fields missing. Built here, sent by core via the backend client, merged back here.
// Only cleaned visible main-content text leaves the device: no scripts, form fields or hidden areas.
import type {
  ExtractFallbackRequest,
  ExtractFallbackResponse,
  ProductJSON,
  SourceMethod,
} from '@shared/index';
import { ORDER_NUMBER } from './orders';
import { missingPaths } from './product';
import { clean, HIDDEN_SELECTOR, isHidden, siteOf } from './util';

export interface LlmFallbackRequest {
  url: string;
  site: string;
  /** ProductJSON dot paths still missing after the faster tiers. */
  missing: string[];
  /** Cleaned visible main-content text, capped at MAX_CHARS (~4k tokens). */
  text: string;
  truncated: boolean;
}

const MAX_CHARS = 16000;

const DROP = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'header',
  'nav',
  'footer',
  'input',
  'textarea',
  'select',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '#navbar',
  '#navFooter',
].join(', ');

/** Order numbers, card-like numbers, emails and phone numbers never go to an LLM. */
export function redact(text: string): string {
  return text
    .replace(ORDER_NUMBER, '[ORDER]') // before the card rule, which would also match it
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[NUMBER]')
    .replace(/(?:\+91[ -]?)?\b[6-9]\d{9}\b/g, '[PHONE]');
}

export function buildLlmFallbackRequest(
  doc: Document,
  url: string,
  missing: string[],
): LlmFallbackRequest {
  const h1 = Array.from(doc.querySelectorAll('h1')).find((h) => !isHidden(h));
  // The main-content landmark, if it actually holds the product title; otherwise the body.
  const landmark = doc.querySelector('main, [role="main"], article');
  const root = landmark && (!h1 || landmark.contains(h1)) ? landmark : doc.body;
  const copy = root ? (root.cloneNode(true) as Element) : null;
  copy?.querySelectorAll(`${DROP}, ${HIDDEN_SELECTOR}`).forEach((e) => e.remove());
  const blocks = Array.from(
    copy?.querySelectorAll('h1, h2, h3, p, li, tr, dt, dd, span, div') ?? [],
  )
    .filter((e) => !e.querySelector('h1, h2, h3, p, li, tr, dt, dd, div'))
    .map((e) => clean(e.textContent))
    .filter((t): t is string => !!t);
  // The page title first, so the cap never cuts the one thing every extraction needs.
  const title = clean(h1?.textContent);
  const lines: string[] = title ? [title] : [];
  for (const b of blocks) if (lines[lines.length - 1] !== b) lines.push(b);
  const full = redact(lines.join('\n'));
  return {
    url,
    site: siteOf(url),
    missing,
    text: full.slice(0, MAX_CHARS),
    truncated: full.length > MAX_CHARS,
  };
}

/**
 * Fields worth an LLM call when the faster tiers missed them. Price is never among them:
 * payable details come only from JSON-LD and adapters (docs/decisions.md, 2026-10-11).
 */
const FALLBACK_FIELDS = [
  'title',
  'brand',
  'rating',
  'availability',
  'category',
  'specs',
  'delivery',
  'seller',
] as const;

/** The missing fields the fallback could fill, or [] when the product needs no LLM call. */
export function needsFallback(product: ProductJSON): string[] {
  return product.missing.filter((m) => (FALLBACK_FIELDS as readonly string[]).includes(m));
}

/** Request body for POST /extract/fallback, or null when nothing worth asking for is missing. */
export function buildFallbackRequest(
  doc: Document,
  product: ProductJSON,
): ExtractFallbackRequest | null {
  const missing = needsFallback(product);
  if (!missing.length) return null;
  return { schema_version: '1.0', ...buildLlmFallbackRequest(doc, product.url, missing) };
}

/**
 * Merges the fallback's findings into the product as source method `llm`. Only fills fields
 * that are still empty (the page's own tiers always win) and never takes a price.
 */
export function applyFallback(product: ProductJSON, res: ExtractFallbackResponse): ProductJSON {
  const out: ProductJSON = structuredClone(product);
  const fields: Record<string, SourceMethod> = { ...out.source.fields };
  const found = res.found;
  let used = false;
  const take = <
    K extends 'title' | 'brand' | 'rating' | 'availability' | 'category' | 'delivery' | 'seller',
  >(
    key: K,
  ): void => {
    const value = found[key];
    if (value == null || out[key] != null) return;
    (out as Record<K, unknown>)[key] = value;
    fields[key] = 'llm';
    used = true;
  };
  take('title');
  take('brand');
  take('rating');
  take('availability');
  take('category');
  take('delivery');
  take('seller');
  for (const [key, spec] of Object.entries(found.specs)) {
    if (key in out.specs) continue;
    out.specs[key] = spec;
    fields[`specs.${key}`] = 'llm';
    used = true;
  }
  out.source = { ...out.source, fields, method: used ? 'llm' : out.source.method };
  out.missing = missingPaths(out);
  return out;
}
