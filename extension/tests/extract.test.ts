import { describe, expect, it } from 'vitest';
import { extractPageContext } from '../src/extract';

describe('extract (stub)', () => {
  it('returns an empty PageContext', () => {
    const ctx = extractPageContext(document);
    expect(ctx.page_type).toBe('other');
    expect(ctx.products).toEqual([]);
  });
});
