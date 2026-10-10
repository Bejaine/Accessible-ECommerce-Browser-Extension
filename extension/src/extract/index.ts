// Page extraction (Track B). STUB: returns an empty PageContext for any document.
import type { PageContext } from '@shared/index';

export function extractPageContext(doc: Document = document): PageContext {
  const url = doc.location?.href ?? 'about:blank';
  return {
    page_type: 'other',
    url,
    site: doc.location?.hostname ?? '',
    products: [],
    targets: [],
  };
}
