// Small parsing helpers shared by the JSON-LD parser and the site adapters.
import type { SpecValue } from '@shared/index';

/** Collapses whitespace; returns null for empty strings. */
export function clean(text: string | null | undefined): string | null {
  if (text == null) return null;
  const t = text.replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

export function textOf(el: Element | null | undefined): string | null {
  return el ? clean(el.textContent) : null;
}

/** Text with a space between text nodes, so "↓7%" "13,999" "₹12,999" don't run together. */
export function spacedText(el: Element | null | undefined): string | null {
  if (!el) return null;
  const parts: string[] = [];
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) parts.push(child.textContent ?? '');
      else if (
        child.nodeType === 1 &&
        !/^(SCRIPT|STYLE|TEMPLATE)$/i.test((child as Element).tagName)
      ) {
        walk(child);
      }
    }
  };
  walk(el);
  return clean(parts.join(' '));
}

/** Selector for things hidden by attribute, inline style or the shops' own hiding classes. */
export const HIDDEN_SELECTOR = [
  '[hidden]',
  '[aria-hidden="true"]',
  '[style*="display: none"]',
  '[style*="display:none"]',
  '[style*="visibility: hidden"]',
  'template',
  '.aok-hidden',
  '.a-hidden',
  '.a-popover-preload',
].join(', ');

/**
 * True if the user can't see the element. Uses the browser's own check where it has layout
 * (checkVisibility); the selector covers saved pages parsed without stylesheets.
 */
export function isHidden(el: Element): boolean {
  if (el.closest(HIDDEN_SELECTOR)) return true;
  const check = (el as Element & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof check === 'function' && el.ownerDocument.defaultView != null
    ? !check.call(el)
    : false;
}

/** Alt text that names nothing ("Image", "icon") is treated as absent. */
export function meaningfulAlt(el: Element | null | undefined): string | null {
  const alt = clean(el?.getAttribute('alt'));
  return alt && !/^(image|img|photo|picture|icon|logo|thumbnail)$/i.test(alt) ? alt : null;
}

/** "₹1,23,999.00" → 123999; null when there is no number. */
export function parseMoney(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** "11,058" → 11058. */
export function parseCount(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.replace(/,/g, '').match(/\d+/);
  return m ? Number(m[0]) : null;
}

/** Turns a page label into a ProductJSON spec key: "Battery Capacity (mAh)" → "battery_capacity_mah". */
export function specKey(label: string): string {
  const key = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return key === '' ? 'spec' : key;
}

const UNIT = /^(-?\d[\d,]*(?:\.\d+)?)\s*([A-Za-z%°µ"][A-Za-z0-9%°µ/"]*)?$/;

/** "5000 mAh" → {value: 5000, unit: "mAh"}; "Yes" → true; anything else stays a string. */
export function parseSpecValue(label: string, raw: string): SpecValue {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (/^yes$/i.test(text)) return { label, value: true, unit: null };
  if (/^no$/i.test(text)) return { label, value: false, unit: null };
  const m = text.match(UNIT);
  if (m && m[1]) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n)) return { label, value: n, unit: m[2] ?? null };
  }
  return { label, value: text, unit: null };
}

/** Adds spec under a unique key (later duplicates get _2, _3…). */
export function addSpec(specs: Record<string, SpecValue>, label: string, raw: string): void {
  const l = clean(label)?.replace(/[:\s]+$/, '');
  const v = clean(raw);
  if (!l || !v) return;
  const base = specKey(l);
  let key = base;
  for (let i = 2; key in specs; i++) {
    if (specs[key]?.label === l) return; // same row rendered twice
    key = `${base}_${i}`;
  }
  specs[key] = parseSpecValue(l, v);
}

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;

/**
 * Finds a calendar date in page wording ("Monday, 12 October", "14 Oct", "8 October 2026") and
 * returns YYYY-MM-DD. Without a year, the next occurrence on or after `now` is used.
 * Relative words ("Tomorrow") are not resolved: we don't guess.
 */
export function parseDayMonth(text: string | null | undefined, now: Date): string | null {
  if (!text) return null;
  const m = text.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?(?:,?\s+(\d{4}))?\b/);
  if (!m || !m[1] || !m[2]) return null;
  const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase() as (typeof MONTHS)[number]);
  if (month < 0) return null;
  const day = Number(m[1]);
  let year = m[3] ? Number(m[3]) : now.getUTCFullYear();
  if (!m[3]) {
    const candidate = Date.UTC(year, month, day);
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (candidate < today) year += 1;
  }
  const d = new Date(Date.UTC(year, month, day));
  if (d.getUTCMonth() !== month) return null;
  return d.toISOString().slice(0, 10);
}

/** Site key used in ProductJSON ids: "www.amazon.in" → "amazon.in". */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/^m\./, '') || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function absoluteUrl(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}
