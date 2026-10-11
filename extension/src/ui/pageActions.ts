// "Actions on this page", curated. Track B's page map lists every control (up to 200), and real
// shop pages repeat the same destination many times: a product card's image, title, price and
// rating are four links to one page; "Read more about battery" appears four times; prices, rating
// counts and "+7 other colours" are links too. Measured on saved pages: 200 targets on an
// Amazon.in product page, 155 distinct labels. The menu and switch scanning show one entry per
// destination with its most descriptive label, drop entries that are only a price or a count, and
// put the product's own actions first. Nothing is removed from the page map itself (the matcher
// and the backend still see everything).
import type { ActionTarget, Zone } from '@shared/index';

/** Labels that only repeat a number the menu would read as noise. */
const NOISE = [
  /^[\s₹$€£.,\d-]*$/, // only a price / number
  /^(₹|rs\.?\s|m\.r\.p)/i, // starts with a price
  /^[\d,.]+\s*(ratings?|reviews?|answered questions?)$/i, // "21,106 ratings"
  /^\+\s*\d+\s+other\s+colou?rs?/i, // "+7 other colors/patterns"
  /^[\d.]+\s*out of 5( stars)?$/i, // "4.2 out of 5 stars"
];

const norm = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();

export function isNoiseLabel(label: string): boolean {
  const l = label.trim();
  // No letters at all ("4.1", "8,263", "₹13,999"): a number, not an action.
  return !/\p{L}/u.test(l) || NOISE.some((re) => re.test(l));
}

/** One destination per page: drop query, hash and Amazon's "/ref=…" tracking segment. */
export function destinationKey(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, 'https://x.invalid');
    if (!/^https?:$/.test(url.protocol)) return null;
    return `${url.host}${url.pathname.replace(/\/ref=[^/]*$/, '').replace(/\/$/, '')}`;
  } catch {
    return null;
  }
}

/** Zones in the order a shopper needs them on the menu (the product's own actions first). */
export const ACTION_ZONE_ORDER: readonly Zone[] = [
  'product',
  'cart',
  'checkout',
  'orders',
  'search',
  'results',
  'help',
];

/**
 * The page's actions without repeats: one per destination (links) or per label (everything
 * else) within a zone, keeping the most descriptive label; price- or count-only labels dropped.
 * `hrefOf` maps a target id to its link's address (resolved on the page; null if not a link).
 */
export function curateTargets(
  targets: readonly ActionTarget[],
  hrefOf: (id: string) => string | null = () => null,
): ActionTarget[] {
  const kept = new Map<string, ActionTarget>();
  for (const t of targets) {
    if (t.state?.disabled || isNoiseLabel(t.label)) continue;
    const dest = t.kind === 'link' ? destinationKey(hrefOf(t.id)) : null;
    const key = `${t.zone}|${dest ?? `label:${norm(t.label)}`}`;
    const seen = kept.get(key);
    // Keep the first position, but the more descriptive (longer) label of the two.
    if (!seen) kept.set(key, t);
    else if (t.label.trim().length > seen.label.trim().length) kept.set(key, t);
  }
  // A link and a button with the same words in one zone ("Add to Cart" twice): keep one.
  const byLabel = new Set<string>();
  const out: ActionTarget[] = [];
  for (const t of kept.values()) {
    const k = `${t.zone}|${norm(t.label)}`;
    if (byLabel.has(k)) continue;
    byLabel.add(k);
    out.push(t);
  }
  return ACTION_ZONE_ORDER.flatMap((zone) => out.filter((t) => t.zone === zone));
}
