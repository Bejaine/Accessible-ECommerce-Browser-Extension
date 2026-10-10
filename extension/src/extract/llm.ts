// Tier 3: the request for LLM-fallback extraction when JSON-LD and the site adapter leave
// key fields missing. Built here, sent by core to the backend (no endpoint yet; see STATUS.md).
// Only cleaned visible main-content text leaves the device: no scripts, form fields or hidden areas.
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

/** Card-like numbers, emails and phone numbers never go to an LLM. */
export function redact(text: string): string {
  return text
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
