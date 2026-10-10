import { describe, expect, it } from 'vitest';
import type { ExtractFallbackResponse } from '@shared/index';
import {
  applyFallback,
  buildFallbackRequest,
  buildLlmFallbackRequest,
  extractProduct,
  needsFallback,
} from '../../src/extract';
import { redact } from '../../src/extract/llm';
import { fixture, loadPage, NOW, schemaErrors } from './helpers';

describe('LLM fallback request', () => {
  it('sends cleaned, capped main-content text and the missing fields', () => {
    const f = fixture('amazon-product-cooker.html');
    const req = buildLlmFallbackRequest(loadPage(f.file), f.url, ['seller']);
    expect(req.site).toBe('amazon.in');
    expect(req.missing).toEqual(['seller']);
    expect(req.text.length).toBeGreaterThan(500);
    expect(req.text.length).toBeLessThanOrEqual(16000);
    expect(req.text).toContain('Hawkins');
  });

  it('redacts emails, phone numbers and card-like numbers', () => {
    expect(redact('mail a@b.co or call 9876543210, card 4111 1111 1111 1111')).toBe(
      'mail [EMAIL] or call [PHONE], card [NUMBER]',
    );
  });
});

describe('/extract/fallback round trip', () => {
  const f = fixture('flipkart-product-phone.html');
  const base = () => {
    const p = extractProduct(loadPage(f.file), { url: f.url, now: NOW });
    if (!p) throw new Error('no product');
    return p;
  };

  it('asks only for missing fields the fallback may fill, never price', () => {
    const p = {
      ...base(),
      seller: null,
      missing: ['seller', 'price', 'price.mrp', 'delivery.cost'],
    };
    expect(needsFallback(p)).toEqual(['seller']);
    const req = buildFallbackRequest(loadPage(f.file), p);
    expect(req?.schema_version).toBe('1.0');
    expect(req?.missing).toEqual(['seller']);
    expect(buildFallbackRequest(loadPage(f.file), { ...p, missing: ['price'] })).toBeNull();
  });

  it('fills only empty fields, marks them llm, and stays schema-valid', () => {
    const p = { ...base(), seller: null, brand: null };
    const res: ExtractFallbackResponse = {
      schema_version: '1.0',
      found: {
        title: 'Something else',
        brand: 'Ai+',
        price: { amount: 1, currency: 'INR', mrp: null },
        rating: null,
        availability: null,
        category: null,
        specs: {
          weight: { label: 'Weight', value: 199, unit: 'g' },
          ram: { label: 'RAM', value: 99, unit: 'GB' },
        },
        delivery: null,
        seller: 'IndiFlashMart',
      },
      evidence: [{ field_path: 'seller', snippet: 'Seller: IndiFlashMart' }],
      missing: [],
    };
    const out = applyFallback(p, res);
    expect(out.title).toBe(p.title); // page tiers win
    expect(out.price).toEqual(p.price); // never from the LLM
    expect(out.seller).toBe('IndiFlashMart');
    expect(out.brand).toBe('Ai+');
    expect(out.specs.ram?.value).toBe(4); // existing spec kept
    expect(out.specs.weight).toEqual({ label: 'Weight', value: 199, unit: 'g' });
    expect(out.source).toMatchObject({
      method: 'llm',
      fields: { seller: 'llm', brand: 'llm', 'specs.weight': 'llm' },
    });
    expect(out.missing).not.toContain('seller');
    expect(schemaErrors('ProductJSON', out)).toEqual([]);
  });
});
