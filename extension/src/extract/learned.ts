// Learned adapters (docs/product.md): when the LLM fallback finds a field, its evidence snippet
// is located in the live page and remembered as a selector for that site. The next page from the
// site reads the field directly, without an LLM call. Kept in browser.storage.local, per site.
//
// Rules only ever fill fields the built-in tiers left empty, and never read a price: payable
// details come from the shop's own markup or the site adapters (a learned price selector could
// land on a bank-offer price, the mistake that made /extract/fallback stop returning prices).
import type { ExtractFallbackRequest, ExtractFallbackResponse, ProductJSON } from '@shared/index';
import { applyFallback, buildFallbackRequest } from './llm';
import { missingPaths } from './product';
import { isSecureElement } from './secure';
import { addSpec, clean, isHidden, parseDayMonth, siteOf, spacedText } from './util';

type TextField = 'title' | 'brand' | 'category' | 'seller' | 'availability' | 'delivery';
const TEXT_FIELDS: readonly TextField[] = [
  'title',
  'brand',
  'category',
  'seller',
  'availability',
  'delivery',
];

export type LearnedRule =
  | { field: TextField; selector: string }
  /** A spec row: the element matching `selector` whose text starts with `label`. */
  | { field: 'specs'; key: string; label: string; selector: string };

export interface LearnedAdapter {
  site: string;
  learned_at: string;
  rules: LearnedRule[];
}

/** The part of browser.storage.local this module uses (injectable for tests). */
export interface LearnedStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const STORAGE_KEY = 'asl-learned-adapters';
const MAX_RULES = 60;
const adapters = new Map<string, LearnedAdapter>();

export function learnedAdapterFor(site: string): LearnedAdapter | null {
  return adapters.get(site) ?? null;
}

/** Replaces the in-memory adapters (tests, or after loading from storage). */
export function setLearnedAdapters(list: LearnedAdapter[]): void {
  adapters.clear();
  for (const a of list) adapters.set(a.site, a);
}

export async function loadLearnedAdapters(store: LearnedStore): Promise<void> {
  const stored = (await store.get(STORAGE_KEY))[STORAGE_KEY];
  if (Array.isArray(stored)) setLearnedAdapters(stored as LearnedAdapter[]);
}

const ruleKey = (r: LearnedRule): string => (r.field === 'specs' ? `specs.${r.key}` : r.field);

/** Adds new rules to the site's adapter (a newer rule for the same field replaces the old). */
export async function saveLearnedRules(
  store: LearnedStore | null,
  site: string,
  rules: LearnedRule[],
  now: Date = new Date(),
): Promise<void> {
  if (!rules.length) return;
  const byKey = new Map((adapters.get(site)?.rules ?? []).map((r) => [ruleKey(r), r]));
  for (const r of rules) {
    byKey.delete(ruleKey(r));
    byKey.set(ruleKey(r), r);
  }
  adapters.set(site, {
    site,
    learned_at: now.toISOString(),
    rules: Array.from(byKey.values()).slice(-MAX_RULES),
  });
  await store?.set({ [STORAGE_KEY]: Array.from(adapters.values()) });
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** The smallest visible element whose text contains the snippet. */
function elementWithText(doc: Document, snippet: string): Element | null {
  const want = norm(snippet);
  if (want.length < 2) return null;
  let best: Element | null = null;
  for (const el of Array.from(doc.body?.querySelectorAll('*') ?? [])) {
    if (/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(el.tagName) || isHidden(el)) continue;
    if (!norm(spacedText(el) ?? '').includes(want)) continue;
    // Document order visits ancestors first, so a later match inside `best` is smaller.
    if (!best || best.contains(el)) best = el;
  }
  return best;
}

// Class names that look generated per build/session are not stable across pages.
const STABLE = /^[A-Za-z][\w-]{1,40}$/;
const unstable = (name: string): boolean => /\d{3,}/.test(name);

function part(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList).filter((c) => STABLE.test(c) && !unstable(c));
  return (
    tag +
    classes
      .slice(0, 3)
      .map((c) => `.${CSS.escape(c)}`)
      .join('')
  );
}

/** A selector for `el` that should hold on other pages of the site: an id, or a short class path. */
function selectorFor(el: Element): string | null {
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && node.tagName !== 'BODY' && depth < 4; depth++) {
    const id = node.getAttribute('id');
    if (id && STABLE.test(id) && !unstable(id)) {
      parts.unshift(`#${CSS.escape(id)}`);
      return parts.join(' > ');
    }
    parts.unshift(part(node));
    node = node.parentElement;
  }
  return parts.length ? parts.join(' > ') : null;
}

function firstVisible(doc: Document, selector: string): Element | null {
  try {
    return Array.from(doc.querySelectorAll(selector)).find((el) => !isHidden(el)) ?? null;
  } catch {
    return null; // a stored selector the page's DOM can't parse
  }
}

function specRow(doc: Document, rule: { label: string; selector: string }): Element | null {
  try {
    return (
      Array.from(doc.querySelectorAll(rule.selector)).find(
        (el) => !isHidden(el) && norm(spacedText(el) ?? '').startsWith(norm(rule.label)),
      ) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Rules for the fields the fallback found, located from its evidence snippets in this page.
 * A rule is kept only if its selector finds the same element again here.
 */
export function learnFromFallback(
  doc: Document,
  product: ProductJSON,
  res: ExtractFallbackResponse,
): LearnedRule[] {
  const rules: LearnedRule[] = [];
  for (const { field_path, snippet } of res.evidence) {
    const [top, key] = field_path.split('.');
    const el = elementWithText(doc, snippet);
    if (!el || isSecureElement(el)) continue;
    if (top === 'specs' && key) {
      const label = res.found.specs[key]?.label ?? product.specs[key]?.label;
      // The snippet may hold only the value: use the row that starts with the label.
      let row: Element | null = el;
      for (let i = 0; row && i < 3; i++, row = row.parentElement) {
        if (label && norm(spacedText(row) ?? '').startsWith(norm(label))) break;
      }
      const rowSelector = row ? selectorFor(row) : null;
      if (!label || !row || !rowSelector) continue;
      const rule = { field: 'specs' as const, key, label, selector: rowSelector };
      if (specRow(doc, rule) === row) rules.push(rule);
    } else if ((TEXT_FIELDS as readonly string[]).includes(top ?? '')) {
      const selector = selectorFor(el);
      if (selector && firstVisible(doc, selector) === el) {
        rules.push({ field: top as TextField, selector });
      }
    }
  }
  return rules;
}

function availabilityStatus(text: string): NonNullable<ProductJSON['availability']>['status'] {
  if (/only \d+ left|few left|hurry/i.test(text)) return 'low_stock';
  if (/out of stock|unavailable|sold out/i.test(text)) return 'out_of_stock';
  if (/pre-?order/i.test(text)) return 'preorder';
  if (/in stock|available/i.test(text)) return 'in_stock';
  return 'unknown';
}

/** Fills the product's empty fields from the site's learned rules (source method `adapter`). */
export function applyLearned(
  doc: Document,
  product: ProductJSON,
  adapter: LearnedAdapter | null = learnedAdapterFor(product.site),
  now: Date = new Date(),
): ProductJSON {
  if (!adapter?.rules.length) return product;
  const out: ProductJSON = structuredClone(product);
  const fields = { ...out.source.fields };
  for (const rule of adapter.rules) {
    if (rule.field === 'specs') {
      if (rule.key in out.specs) continue;
      const row = specRow(doc, rule);
      const text = clean(spacedText(row));
      if (!text) continue;
      const value = clean(text.slice(rule.label.length).replace(/^\s*:?/, ''));
      if (!value) continue;
      const before = Object.keys(out.specs).length;
      addSpec(out.specs, rule.label, value);
      if (Object.keys(out.specs).length > before) fields[`specs.${rule.key}`] = 'adapter';
      continue;
    }
    if (out[rule.field] != null) continue;
    const text = clean(spacedText(firstVisible(doc, rule.selector)));
    if (!text || text.length > 300) continue;
    if (rule.field === 'availability') {
      out.availability = { status: availabilityStatus(text), text };
    } else if (rule.field === 'delivery') {
      out.delivery = {
        text,
        cost: /^free\b|free delivery/i.test(text) ? { amount: 0, currency: 'INR' } : null,
        date: parseDayMonth(text, now),
      };
    } else {
      out[rule.field] = text;
    }
    fields[rule.field] = 'adapter';
  }
  out.source = { ...out.source, fields };
  out.missing = missingPaths(out);
  return out;
}

/**
 * The whole tier-3 round trip for core: ask /extract/fallback only if fields are still missing,
 * merge the answer (never a price), learn rules from its evidence and save them for this site.
 */
export async function completeWithFallback(
  doc: Document,
  product: ProductJSON,
  extractFallback: (req: ExtractFallbackRequest) => Promise<ExtractFallbackResponse>,
  store: LearnedStore | null = null,
): Promise<ProductJSON> {
  const req = buildFallbackRequest(doc, product);
  if (!req) return product;
  const res = await extractFallback(req);
  await saveLearnedRules(store, siteOf(product.url), learnFromFallback(doc, product, res));
  return applyFallback(product, res);
}
