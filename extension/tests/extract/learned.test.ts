// Learned adapters: rules located from /extract/fallback evidence on one page of a site, then
// reused on another page of the same site without an LLM call. Synthetic shop (two pages from
// the same template), since the point is a site none of the built-in adapters knows.
import { beforeEach, describe, expect, it } from 'vitest';
import type { ExtractFallbackRequest, ExtractFallbackResponse } from '@shared/index';
import {
  applyLearned,
  completeWithFallback,
  extractProduct,
  learnFromFallback,
  loadLearnedAdapters,
  setLearnedAdapters,
} from '../../src/extract';
import { NOW, schemaErrors } from './helpers';

function shopPage(p: {
  title: string;
  price: string;
  delivery: string;
  seller: string;
  specs: [string, string][];
}): Document {
  return new DOMParser().parseFromString(
    `<html><head><meta property="og:type" content="product"><meta property="og:title" content="${p.title}"></head><body><main>
      <h1 class="pdp-title">${p.title}</h1>
      <div class="pdp-price">${p.price}</div>
      <div class="bank-offer">Get it for ₹999 with SuperBank cards</div>
      <div class="ship-box"><span class="ship-msg">${p.delivery}</span></div>
      <div class="sold-by">Sold by <b class="seller-name">${p.seller}</b></div>
      <table class="spec-table">${p.specs.map(([k, v]) => `<tr class="spec-row"><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
    </main></body></html>`,
    'text/html',
  );
}

const KETTLE_URL = 'https://shop.example.in/p/kettle';
const kettle = (): Document =>
  shopPage({
    title: 'Acme Kettle 1.5 L',
    price: '₹1,299',
    delivery: 'Free delivery by Friday, 16 Oct',
    seller: 'KitchenCo Retail',
    specs: [
      ['Capacity', '1.5 L'],
      ['Power', '1500 W'],
    ],
  });
const toaster = (): Document =>
  shopPage({
    title: 'Acme Toaster',
    price: '₹1,899',
    delivery: 'Delivery ₹40 by Monday, 19 Oct',
    seller: 'ToastMart',
    specs: [
      ['Slots', '2'],
      ['Power', '800 W'],
    ],
  });

const fallback: ExtractFallbackResponse = {
  schema_version: '1.0',
  found: {
    title: null,
    brand: null,
    price: null,
    rating: null,
    availability: null,
    category: null,
    specs: {
      capacity: { label: 'Capacity', value: 1.5, unit: 'L' },
      power: { label: 'Power', value: 1500, unit: 'W' },
    },
    delivery: {
      text: 'Free delivery by Friday, 16 Oct',
      cost: { amount: 0, currency: 'INR' },
      date: null,
    },
    seller: 'KitchenCo Retail',
  },
  evidence: [
    { field_path: 'seller', snippet: 'KitchenCo Retail' },
    { field_path: 'delivery.text', snippet: 'Free delivery by Friday, 16 Oct' },
    { field_path: 'specs.capacity', snippet: 'Capacity 1.5 L' },
    { field_path: 'specs.power', snippet: '1500 W' }, // value only: the row is found from the label
    { field_path: 'price.amount', snippet: '₹999' }, // prices are never learned
  ],
  missing: [],
};

beforeEach(() => setLearnedAdapters([]));

describe('learned adapters', () => {
  it('learns selectors from evidence, never for a price', () => {
    const doc = kettle();
    const product = extractProduct(doc, { url: KETTLE_URL, now: NOW })!;
    expect(learnFromFallback(doc, product, fallback)).toEqual([
      { field: 'seller', selector: 'main > div.sold-by > b.seller-name' },
      { field: 'delivery', selector: 'main > div.ship-box > span.ship-msg' },
      {
        field: 'specs',
        key: 'capacity',
        label: 'Capacity',
        selector: 'main > table.spec-table > tbody > tr.spec-row',
      },
      {
        field: 'specs',
        key: 'power',
        label: 'Power',
        selector: 'main > table.spec-table > tbody > tr.spec-row',
      },
    ]);
  });

  it('the next page of the site fills those fields without the LLM', async () => {
    const store = memoryStore();
    const calls: ExtractFallbackRequest[] = [];
    const first = extractProduct(kettle(), { url: KETTLE_URL, now: NOW })!;
    expect(first.missing).toEqual(expect.arrayContaining(['seller', 'delivery']));
    await completeWithFallback(kettle(), first, async (req) => (calls.push(req), fallback), store);
    expect(calls).toHaveLength(1);

    // A fresh session: rules come back from storage.
    setLearnedAdapters([]);
    await loadLearnedAdapters(store);
    const next = extractProduct(toaster(), { url: 'https://shop.example.in/p/toaster', now: NOW })!;
    expect(schemaErrors('ProductJSON', next)).toEqual([]);
    expect(next.seller).toBe('ToastMart');
    expect(next.delivery).toEqual({
      text: 'Delivery ₹40 by Monday, 19 Oct',
      cost: null,
      date: '2026-10-19',
    });
    expect(next.specs.power).toEqual({ label: 'Power', value: 800, unit: 'W' });
    expect(next.price).toBeNull(); // not learned, so still missing rather than the bank offer
    expect(next.source.fields).toMatchObject({
      seller: 'adapter',
      delivery: 'adapter',
      'specs.power': 'adapter',
    });
    expect(next.missing).not.toContain('seller');
  });

  it('never overrides what the page tiers found, and ignores rules that match nothing', () => {
    const doc = toaster();
    const product = extractProduct(doc, { url: 'https://shop.example.in/p/toaster', now: NOW })!;
    const out = applyLearned(doc, product, {
      site: 'shop.example.in',
      learned_at: NOW.toISOString(),
      rules: [
        { field: 'title', selector: 'div.bank-offer' },
        { field: 'seller', selector: 'div.not-there' },
        { field: 'brand', selector: '][not a selector' },
      ],
    });
    expect(out.title).toBe('Acme Toaster');
    expect(out.seller).toBeNull();
    expect(out.brand).toBeNull();
  });

  it('rules belong to one site only', () => {
    setLearnedAdapters([
      {
        site: 'other.example.in',
        learned_at: NOW.toISOString(),
        rules: [{ field: 'seller', selector: 'b.seller-name' }],
      },
    ]);
    expect(
      extractProduct(toaster(), { url: 'https://shop.example.in/p/toaster', now: NOW })!.seller,
    ).toBeNull();
  });
});

function memoryStore() {
  const data: Record<string, unknown> = {};
  return {
    get: async (key: string) => ({ [key]: structuredClone(data[key]) }),
    set: async (items: Record<string, unknown>) => void Object.assign(data, structuredClone(items)),
  };
}
