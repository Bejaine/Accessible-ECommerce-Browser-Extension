import { describe, expect, it } from 'vitest';
import { buildPageMap, extractPageContext, resolveTarget } from '../../src/extract';
import { fixture, fixtures, loadPage, NOW, schemaErrors } from './helpers';

function context(file: string) {
  const f = fixture(file);
  const doc = loadPage(f.file);
  return { doc, ctx: extractPageContext(doc, { url: f.url, now: NOW }) };
}

describe('page map', () => {
  it.each(fixtures)('$file: targets are valid, unique and resolvable', (f) => {
    const { doc, ctx } = context(f.file);
    const ids = ctx.targets.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ctx.targets.length).toBeLessThanOrEqual(200);
    for (const t of ctx.targets) {
      expect(schemaErrors('ActionTarget', t)).toEqual([]);
      expect(t.label.trim()).not.toBe('');
      expect(resolveTarget(t.id, doc)).not.toBeNull();
    }
  });

  it('finds Add to cart / Buy Now on the Amazon product page, in the product zone', () => {
    const { ctx } = context('amazon-product-phone.html');
    const add = ctx.targets.find((t) => /^add to cart$/i.test(t.label));
    expect(add).toMatchObject({ kind: 'button', zone: 'product' });
    expect(ctx.targets.some((t) => /^buy now$/i.test(t.label))).toBe(true);
  });

  it('marks colour swatches with their colour name, and links variants to targets', () => {
    const { ctx } = context('amazon-product-phone.html');
    const swatches = ctx.targets.filter((t) => t.kind === 'swatch');
    expect(swatches.map((t) => t.colour_name)).toEqual([
      'Awesome Midnight Blue',
      'Awesome Violet Glow',
      'Awesome Olive',
    ]);
    expect(swatches.find((t) => t.colour_name === 'Awesome Midnight Blue')?.state?.selected).toBe(
      true,
    );
    const ids = new Set(ctx.targets.map((t) => t.id));
    for (const v of ctx.products[0]?.variants ?? []) expect(ids.has(v.target_id ?? '')).toBe(true);
  });

  it('puts the site search box in the search zone', () => {
    for (const file of ['amazon-product-phone.html', 'flipkart-search-mobiles.html']) {
      const { ctx } = context(file);
      expect(
        ctx.targets.some((t) => t.zone === 'search' && t.kind === 'input'),
        file,
      ).toBe(true);
    }
  });

  it('keeps ids stable when the map is rebuilt', () => {
    const f = fixture('flipkart-product-phone.html');
    const doc = loadPage(f.file);
    const a = buildPageMap(doc, { pageType: 'product', url: f.url });
    const b = buildPageMap(doc, { pageType: 'product', url: f.url });
    expect(b.map((t) => t.id)).toEqual(a.map((t) => t.id));
  });

  it('labels run-together text with spaces', () => {
    const { ctx } = context('flipkart-product-phone.html');
    expect(ctx.targets.some((t) => /\d₹|%\d/.test(t.label))).toBe(false);
    expect(ctx.targets.some((t) => t.label === 'Image')).toBe(false);
  });

  it('never reads input values', () => {
    const doc = new DOMParser().parseFromString(
      '<form><label for="p">Password</label><input id="p" type="password" value="hunter2"></form>',
      'text/html',
    );
    const targets = buildPageMap(doc, { pageType: 'checkout', url: 'https://shop.test/checkout' });
    expect(targets).toHaveLength(1);
    expect(JSON.stringify(targets)).not.toContain('hunter2');
  });
});
