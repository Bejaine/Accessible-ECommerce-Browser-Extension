import type { PageType, ProductJSON } from '@shared/index';
import type { OrderDraft } from '../orders';
import type { ProductDraft } from '../product';

/** Site-specific reader for the parts JSON-LD doesn't cover. Reads the live DOM only. */
export interface SiteAdapter {
  matches(site: string): boolean;
  /** Page type from URL/DOM, or null to fall back to generic detection. */
  pageType(url: string, doc: Document): PageType | null;
  /** What the product page shows; only fields actually found are set. */
  product(doc: Document, url: string, now: Date): ProductDraft;
  /** Result cards on a search page, as ProductJSON. */
  searchResults(doc: Document, url: string, now: Date): ProductJSON[];
  /** Orders on an order list or order detail page (real ids stay on the device). */
  orders?(doc: Document, url: string): OrderDraft[];
  /** The site builds controls from plain <div>s (React Native Web): find them by text too. */
  pseudoButtons?: boolean;
}
