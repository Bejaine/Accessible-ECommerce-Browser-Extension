import { describe, expect, it } from 'vitest';
import { detectPageType, extractPageContext, extractProduct } from '../../src/extract';
import { amazonAdapter } from '../../src/extract/adapters/amazon';
import { flipkartAdapter } from '../../src/extract/adapters/flipkart';
import { fixture, fixtures, loadPage, NOW, schemaErrors } from './helpers';

function product(file: string) {
  const f = fixture(file);
  const p = extractProduct(loadPage(f.file), { url: f.url, now: NOW });
  if (!p) throw new Error(`no product from ${file}`);
  return p;
}

describe('every saved page', () => {
  it.each(fixtures)('$file: detects $page_type and yields a valid PageContext', (f) => {
    const doc = loadPage(f.file);
    expect(detectPageType(doc, f.url)).toBe(f.page_type);
    const ctx = extractPageContext(doc, { url: f.url, now: NOW });
    expect(schemaErrors('PageContext', ctx)).toEqual([]);
    for (const p of ctx.products) {
      expect(schemaErrors('ProductJSON', p), p.id).toEqual([]);
      // Rule 1: anything null is declared missing, never filled in.
      for (const key of ['title', 'brand', 'price', 'rating', 'availability', 'seller'] as const) {
        if (p[key] == null) expect(p.missing, `${p.id} ${key}`).toContain(key);
      }
    }
    if (f.page_type === 'product') expect(ctx.products).toHaveLength(1);
    if (f.page_type === 'search') expect(ctx.products.length).toBeGreaterThanOrEqual(10);
  });
});

describe('Amazon.in adapter', () => {
  it('reads the phone page', () => {
    const p = product('amazon-product-phone.html');
    expect(p.id).toBe('amazon.in:B0H1X5XP25');
    expect(p.source.method).toBe('adapter');
    expect(p.title).toMatch(/^Samsung Galaxy A56 5G/);
    expect(p.brand).toBe('Samsung');
    expect(p.price).toEqual({ amount: 32999, currency: 'INR', mrp: 49999 });
    expect(p.rating).toEqual({ value: 4.4, count: 784 });
    expect(p.availability).toEqual({ status: 'in_stock', text: 'In stock' });
    expect(p.seller).toBe('Clicktech Retail Private Ltd');
    expect(p.delivery).toMatchObject({ cost: { amount: 0, currency: 'INR' }, date: '2026-10-12' });
    expect(p.category).toMatch(/^Electronics > Mobiles/);
    expect(p.specs.processor_speed).toEqual({ label: 'Processor Speed', value: 2.9, unit: 'GHz' });
    expect(p.images.length).toBeGreaterThan(3);
    expect(p.missing).toEqual([]);
  });

  it('reads variants with selection and target ids', () => {
    const variants = product('amazon-product-phone.html').variants ?? [];
    const colours = variants.filter((v) => v.name === 'Colour');
    expect(colours.map((v) => v.value)).toEqual([
      'Awesome Midnight Blue',
      'Awesome Violet Glow',
      'Awesome Olive',
    ]);
    expect(colours.filter((v) => v.selected).map((v) => v.value)).toEqual([
      'Awesome Midnight Blue',
    ]);
    expect(variants.every((v) => v.target_id)).toBe(true);
  });

  it('reads Customers say, aspect mentions, histogram and review items', () => {
    const r = product('amazon-product-phone.html').reviews;
    expect(r?.summary_text).toMatch(/^Customers find the phone offers good value/);
    expect(r?.insights[0]).toEqual({
      topic: 'Value for money',
      sentiment: 'positive',
      mentions: { total: 66, positive: 56, negative: 10 },
    });
    expect(r?.insights.find((i) => i.topic === 'Heat')?.sentiment).toBe('mixed');
    expect(r?.histogram).not.toBeNull();
    expect(r?.basis_count).toBe(r?.items.length);
    expect(r?.items[0]).toMatchObject({ rating: 5, verified: true, date: '2026-09-26' });
    expect(r?.items.every((i) => !/double tap to read/.test(i.text))).toBe(true);
  });

  it('reads the buying option the user would actually buy (accordion buy box)', () => {
    const p = product('amazon-product-cooker.html');
    expect(p.price).toEqual({ amount: 2699, currency: 'INR', mrp: 2800 });
    expect(p.availability).toEqual({ status: 'low_stock', text: 'Only 2 left in stock.' });
    expect(p.seller).toBe('SHIV HOME WORLD');
    expect(p.specs.capacity).toMatchObject({ value: 8 });
    expect(p.variants?.find((v) => v.selected)?.value).toBe('8 Litres');
  });

  it('reads search result cards, including sponsored flags', () => {
    const f = fixture('amazon-search-earphones.html');
    const results = amazonAdapter.searchResults(loadPage(f.file), f.url, NOW);
    expect(results.length).toBeGreaterThanOrEqual(20);
    const first = results[0];
    expect(first?.url).toBe('https://www.amazon.in/dp/B0GF9ZNLWM');
    expect(first?.sponsored).toBe(true);
    expect(first?.price).toEqual({ amount: 26989, currency: 'INR', mrp: 35990 });
    expect(first?.rating).toEqual({ value: 3.9, count: 673 });
    expect(results.some((p) => p.sponsored === false)).toBe(true);
    expect(results.every((p) => !/Or fastest/.test(p.delivery?.text ?? ''))).toBe(true);
  });
});

describe('Flipkart adapter', () => {
  it('adds MRP, seller, delivery and specs to the JSON-LD data', () => {
    const p = product('flipkart-product-phone.html');
    expect(p.id).toBe('flipkart.com:MOBHKHPYYA5KZSYP');
    expect(p.price).toEqual({ amount: 12999, currency: 'INR', mrp: 13999 });
    expect(p.seller).toBe('IndiFlashMart');
    expect(p.delivery).toEqual({
      text: 'Delivery by Wednesday, 14 Oct',
      cost: null,
      date: '2026-10-14',
    });
    expect(p.specs.battery_capacity).toEqual({
      label: 'Battery Capacity',
      value: 6000,
      unit: 'mAh',
    });
    expect(p.specs.ram).toEqual({ label: 'RAM', value: 4, unit: 'GB' });
    expect(p.specs.touchscreen?.value).toBe(true);
    expect(p.source.fields.price).toBe('adapter');
    expect(p.source.fields.rating).toBe('jsonld');
    expect(p.missing).toContain('delivery.cost'); // the page doesn't state it next to the date
  });

  it('names only the variants the page names', () => {
    const variants = product('flipkart-product-phone.html').variants ?? [];
    expect(variants.filter((v) => v.name === 'Color')).toEqual([
      expect.objectContaining({ value: 'Black', selected: true }),
    ]);
    expect(variants.filter((v) => v.name === 'Variant').map((v) => [v.value, v.selected])).toEqual([
      ['128 GB + 4 GB', false],
      ['128 GB + 6 GB', false],
      ['64 GB + 4 GB', true],
    ]);
  });

  it('reads search result cards with clean product URLs', () => {
    const f = fixture('flipkart-search-mobiles.html');
    const results = flipkartAdapter.searchResults(loadPage(f.file), f.url, NOW);
    const first = results[0];
    expect(first?.id).toBe('flipkart.com:MOBHPP597GB8ZHTY');
    expect(first?.url).toBe(
      'https://www.flipkart.com/boltt-evo-midnight-black-64-gb/p/itmf046d663a1fd7?pid=MOBHPP597GB8ZHTY',
    );
    expect(first?.price).toEqual({ amount: 8999, currency: 'INR', mrp: 17999 });
    expect(first?.rating).toEqual({ value: 4.3, count: 2048 });
  });
});
