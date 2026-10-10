import { describe, expect, it } from 'vitest';
import {
  availabilityFromSchema,
  productFromJsonLd,
  productFromMeta,
} from '../../src/extract/jsonld';
import { mergeTiers } from '../../src/extract/product';
import { fixture, loadPage, NOW, schemaErrors } from './helpers';

function html(body: string): Document {
  return new DOMParser().parseFromString(
    `<html><head>${body}</head><body></body></html>`,
    'text/html',
  );
}

describe('JSON-LD tier on saved Flipkart pages', () => {
  it('reads the phone product', () => {
    const f = fixture('flipkart-product-phone.html');
    const d = productFromJsonLd(loadPage(f.file), f.url);
    expect(d.nativeId).toBe('MOBHKHPYYA5KZSYP');
    expect(d.title).toBe('Ai+ Nova 2 5G (Black, 64 GB)');
    expect(d.brand).toBe('Ai+');
    expect(d.price).toEqual({ amount: 12999, currency: 'INR', mrp: null });
    expect(d.rating).toEqual({ value: 4.2, count: 7285 });
    expect(d.availability).toEqual({ status: 'in_stock', text: null });
    expect(d.images?.length).toBe(5);
    expect(d.specs?.colour).toEqual({ label: 'Colour', value: 'Black', unit: null });
    expect(d.reviews?.basis_count).toBe(3);
    expect(d.reviews?.items[0]).toMatchObject({
      rating: 4,
      title: 'Worth the money',
      date: '2026-04-28',
    });
  });

  it('produces valid ProductJSON from JSON-LD alone', () => {
    for (const file of ['flipkart-product-phone.html', 'flipkart-product-earphones.html']) {
      const f = fixture(file);
      const p = mergeTiers(
        [{ method: 'jsonld', draft: productFromJsonLd(loadPage(f.file), f.url) }],
        {
          url: f.url,
          site: 'flipkart.com',
          now: NOW,
        },
      );
      expect(p, file).not.toBeNull();
      expect(schemaErrors('ProductJSON', p), file).toEqual([]);
      expect(p?.source.method).toBe('jsonld');
      expect(p?.missing).toContain('price.mrp'); // JSON-LD has no MRP; never guessed
    }
  });

  it('finds nothing on Amazon product pages (no JSON-LD there)', () => {
    const f = fixture('amazon-product-phone.html');
    expect(productFromJsonLd(loadPage(f.file), f.url)).toEqual({});
  });
});

describe('JSON-LD parsing edge cases', () => {
  it('handles @graph, @type arrays, AggregateOffer, ListPrice and 10-point ratings', () => {
    const doc = html(
      `<script type="application/ld+json">${JSON.stringify({
        '@graph': [
          { '@type': 'BreadcrumbList' },
          {
            '@type': ['Product', 'Thing'],
            name: 'Kettle',
            sku: 'K1',
            brand: 'Acme',
            image: { url: '/k.jpg' },
            aggregateRating: { ratingValue: '8', bestRating: '10', reviewCount: '1,204' },
            offers: [
              {
                '@type': 'AggregateOffer',
                lowPrice: '999.00',
                priceCurrency: 'inr',
                availability: 'https://schema.org/LimitedAvailability',
                priceSpecification: [{ priceType: 'https://schema.org/ListPrice', price: 1499 }],
              },
            ],
            additionalProperty: [{ name: 'Capacity', value: '1.5', unitText: 'L' }],
          },
        ],
      })}</script>`,
    );
    const d = productFromJsonLd(doc, 'https://shop.example/k');
    expect(d.title).toBe('Kettle');
    expect(d.brand).toBe('Acme');
    expect(d.price).toEqual({ amount: 999, currency: 'INR', mrp: 1499 });
    expect(d.rating).toEqual({ value: 4, count: 1204 });
    expect(d.availability?.status).toBe('low_stock');
    expect(d.images?.[0]?.url).toBe('https://shop.example/k.jpg');
    expect(d.specs?.capacity).toEqual({ label: 'Capacity', value: 1.5, unit: 'L' });
  });

  it('skips malformed blocks and keeps going', () => {
    const doc = html(
      '<script type="application/ld+json">{oops</script>' +
        '<script type="application/ld+json">{"@type":"Product","name":"Mug","sku":"M"}</script>',
    );
    expect(productFromJsonLd(doc, 'https://x.test/m').title).toBe('Mug');
  });

  it('maps schema.org availability', () => {
    expect(availabilityFromSchema('https://schema.org/InStock')).toBe('in_stock');
    expect(availabilityFromSchema('http://schema.org/OutOfStock')).toBe('out_of_stock');
    expect(availabilityFromSchema('PreOrder')).toBe('preorder');
    expect(availabilityFromSchema('Weird')).toBe('unknown');
  });

  it('reads product meta tags', () => {
    const doc = html(
      '<meta property="og:type" content="product"><meta property="og:title" content="Lamp">' +
        '<meta property="product:price:amount" content="1,299"><meta property="product:price:currency" content="INR">' +
        '<meta property="og:image" content="https://x.test/l.jpg">',
    );
    const d = productFromMeta(doc, 'https://x.test/lamp');
    expect(d.title).toBe('Lamp');
    expect(d.price).toEqual({ amount: 1299, currency: 'INR', mrp: null });
    expect(d.images?.[0]?.url).toBe('https://x.test/l.jpg');
  });
});
