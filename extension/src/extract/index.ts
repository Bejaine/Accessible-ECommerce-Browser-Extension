// Page extraction (Track B). STUB: returns an empty PageContext for any document.
import type { PageContext } from '@shared/index';

export function extractPageContext(doc: Document = document): PageContext {
  const url = doc.location?.href ?? 'about:blank';
  return {
    schema_version: '1.0',
    page_type: 'other',
    url,
    site: doc.location?.hostname ?? '',
    products: [],
    orders: [],
    targets: [],
    secure_zone_active: false,
  };
}
