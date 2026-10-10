// Page extraction (Track B): JSON-LD/meta → site adapter → (LLM fallback request, built on demand).
// Produces a PageContext with schema-valid ProductJSON and the page map of interactive targets.
import type { OrderJSON, PageContext, PageType, ProductJSON } from '@shared/index';
import { amazonAdapter } from './adapters/amazon';
import { flipkartAdapter } from './adapters/flipkart';
import { mockStoreAdapter } from './adapters/mockstore';
import type { SiteAdapter } from './adapters/types';
import { extractCheckout, redactAddress } from './checkout';
import { hasType, jsonLdNodes, productFromJsonLd, productFromMeta } from './jsonld';
import { redactOrderIds, toOrderJSON } from './orders';
import { mergeTiers, type TierResult } from './product';
import { isSecureZoneActive } from './secure';
import { buildPageMap, resolveTarget } from './targets';
import { siteOf } from './util';

export { applyFallback, buildFallbackRequest, buildLlmFallbackRequest, needsFallback } from './llm';
export {
  isSecureElement,
  isSecureZoneActive,
  muteMicInSecureZone,
  watchSecureZone,
} from './secure';
export { orderStatusFromText, resolveOrderId } from './orders';
export { extractCheckout, resolveAddress, restorePlaceholders } from './checkout';
export { buildPageMap, resolveTarget } from './targets';

const ADAPTERS: SiteAdapter[] = [amazonAdapter, flipkartAdapter, mockStoreAdapter];

export function adapterFor(site: string): SiteAdapter | null {
  return ADAPTERS.find((a) => a.matches(site)) ?? null;
}

export interface ExtractOptions {
  /** Page URL; defaults to doc.location (tests pass the fixture's source URL). */
  url?: string;
  /** Clock for extracted_at and year-less delivery dates. */
  now?: Date;
}

function genericPageType(doc: Document, url: string): PageType {
  const nodes = jsonLdNodes(doc);
  if (nodes.some((n) => hasType(n, 'Product'))) return 'product';
  if (/[?&](q|k|query|search)=/i.test(url) || nodes.some((n) => hasType(n, 'ItemList'))) {
    return 'search';
  }
  if (/\/(cart|basket|bag)\b/i.test(url)) return 'cart';
  if (/\/checkout\b/i.test(url)) return 'checkout';
  if (/\/orders?\b/i.test(url)) return 'orders';
  return 'other';
}

export function detectPageType(doc: Document, url: string): PageType {
  return adapterFor(siteOf(url))?.pageType(url, doc) ?? genericPageType(doc, url);
}

/** The product on a product page: JSON-LD/meta first, then the site adapter overrides. */
export function extractProduct(doc: Document, opts: ExtractOptions = {}): ProductJSON | null {
  const url = opts.url ?? doc.location?.href ?? '';
  const now = opts.now ?? new Date();
  const site = siteOf(url);
  const tiers: TierResult[] = [
    { method: 'jsonld', draft: productFromMeta(doc, url) },
    { method: 'jsonld', draft: productFromJsonLd(doc, url) },
  ];
  const adapter = adapterFor(site);
  if (adapter) tiers.push({ method: 'adapter', draft: adapter.product(doc, url, now) });
  const product = mergeTiers(tiers, { url, site, now });
  if (product || !tiers.some((t) => t.draft.title)) return product;
  // A product without a native id on an unknown site: key it by URL path.
  const path = new URL(url).pathname.replace(/\/+$/, '') || '/';
  tiers.push({ method: 'jsonld', draft: { nativeId: path } });
  return mergeTiers(tiers, { url, site, now });
}

export function extractPageContext(
  doc: Document = document,
  opts: ExtractOptions = {},
): PageContext {
  const url = opts.url ?? doc.location?.href ?? 'about:blank';
  const now = opts.now ?? new Date();
  const site = siteOf(url);
  const pageType = detectPageType(doc, url);
  const adapter = adapterFor(site);

  // Secure zone: extract nothing while the user types a password, card number or OTP.
  if (isSecureZoneActive(doc)) {
    return {
      schema_version: '1.0',
      page_type: pageType,
      url,
      site,
      products: [],
      orders: [],
      targets: [],
      secure_zone_active: true,
    };
  }

  let products: ProductJSON[] = [];
  if (pageType === 'product') {
    const p = extractProduct(doc, { url, now });
    if (p) products = [p];
  } else if (pageType === 'search' && adapter) {
    products = adapter.searchResults(doc, url, now);
  }
  let orders: OrderJSON[] = [];
  if ((pageType === 'orders' || pageType === 'order_detail') && adapter?.orders) {
    orders = adapter.orders(doc, url).map((d) => toOrderJSON(doc, d));
  }
  // Before the page map, so the Place-order button already carries its t-place-order id.
  const checkout = pageType === 'checkout' ? extractCheckout(doc) : null;
  const placeOrder = checkout?.place_order_target_id
    ? resolveTarget(checkout.place_order_target_id, doc)
    : null;

  return {
    schema_version: '1.0',
    page_type: pageType,
    url,
    site,
    products,
    orders,
    // Labels like "Order # 403-…" or "Deliver to <name, address>" must not carry personal
    // data to the backend.
    targets: buildPageMap(doc, { pageType, url, pinned: placeOrder ? [placeOrder] : [] }).map(
      (t) => ({ ...t, label: redactAddress(doc, redactOrderIds(doc, t.label)) }),
    ),
    checkout,
    secure_zone_active: false,
  };
}
