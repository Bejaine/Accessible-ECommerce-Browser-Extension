import { describe, expect, it } from 'vitest';
import { extractPageContext } from '../src/extract';

// Fixture-based extractor tests live in tests/extract/.
describe('extract', () => {
  it('returns an empty PageContext for a page with nothing to extract', () => {
    const ctx = extractPageContext(document);
    expect(ctx.page_type).toBe('other');
    expect(ctx.products).toEqual([]);
    expect(ctx.secure_zone_active).toBe(false);
  });
});
