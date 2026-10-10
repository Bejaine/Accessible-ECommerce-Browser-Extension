// @vitest-environment-options {"settings":{"navigation":{"disableMainFrameNavigation":true},"disableCSSFileLoading":true,"disableJavaScriptFileLoading":true}}
// End-to-end on the mock store: real pages + store.js in the test DOM, driven only through
// extractPageContext (what the backend sees) and performAction (what the extension does).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionTarget, ClientAction, EffectKind, PageContext } from '@shared/index';
import { performAction } from '../src/actuate';
import {
  extractPageContext,
  resolveAddress,
  resolveOrderId,
  restorePlaceholders,
} from '../src/extract';
import { schemaErrors } from './extract/helpers';

const STORE = resolve(__dirname, '../../mock-store');
const STORE_JS = readFileSync(join(STORE, 'store.js'), 'utf8');
const ORIGIN = 'http://localhost:8080';

type HappyWindow = Window & { happyDOM: { setURL(url: string): void }; MOCK_TODAY?: number };

/** Loads a mock-store page as the browser would (minus network) and returns its PageContext. */
function open(path: string): PageContext {
  const win = window as unknown as HappyWindow;
  win.happyDOM.setURL(`${ORIGIN}/${path}`);
  win.MOCK_TODAY = Date.parse('2026-10-10T12:00:00Z');
  const html = readFileSync(join(STORE, path.split('?')[0] ?? ''), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<link[^>]*>/g, '');
  const body = html.match(/<body([^>]*)>([\s\S]*)<\/body>/);
  document.head.innerHTML = html.match(/<head>([\s\S]*)<\/head>/)?.[1] ?? '';
  document.body.innerHTML = body?.[2] ?? '';
  document.body.setAttribute('data-page', body?.[1]?.match(/data-page="(\w+)"/)?.[1] ?? '');
  new Function(STORE_JS)();
  return extractPageContext(document);
}

function target(ctx: PageContext, label: RegExp): ActionTarget {
  const t = ctx.targets.find((x) => label.test(x.label));
  if (!t) throw new Error(`no target ${label} in ${ctx.targets.map((x) => x.label).join(' | ')}`);
  return t;
}

function act(
  type: ClientAction['type'],
  t: ActionTarget | null,
  value: string | null = null,
  kind: EffectKind = 'none',
  detail: string | null = null,
): ClientAction {
  return {
    schema_version: '1.0',
    id: 'a',
    type,
    target_id: t?.id ?? null,
    value,
    expected_effect: { kind, detail },
  };
}

function state(): {
  cart: { id: string; qty: number }[];
  orders: { id: string; status: string }[];
} {
  return JSON.parse(localStorage.getItem('asl-mock-store-v1') ?? '{}');
}

beforeEach(() => localStorage.clear());

describe('mock store pages', () => {
  it.each([
    ['index.html?q=zentra', 'search'],
    ['product.html?id=zx-pulse-5g', 'product'],
    ['cart.html', 'cart'],
    ['checkout.html', 'checkout'],
    ['orders.html', 'orders'],
    ['order.html?id=MS-1001', 'order_detail'],
  ])('%s is a valid %s PageContext', (path, type) => {
    const ctx = open(path);
    expect(ctx.page_type).toBe(type);
    expect(schemaErrors('PageContext', ctx)).toEqual([]);
  });

  it('extracts the product from JSON-LD plus the adapter', () => {
    const p = open('product.html?id=zx-buds-air').products[0];
    expect(p).toMatchObject({
      id: 'localhost:zx-buds-air',
      title: 'Zentra Buds Air Wireless Earbuds',
      price: { amount: 1999, currency: 'INR', mrp: 3999 },
      rating: { value: 4.2, count: 1284 },
      availability: { status: 'in_stock', text: 'In stock' },
      seller: 'MockMart Retail',
      delivery: { cost: { amount: 0, currency: 'INR' }, date: '2026-10-13' },
    });
    expect(p?.specs.battery_life).toEqual({ label: 'Battery life', value: 30, unit: 'h' });
    expect(p?.variants?.map((v) => [v.value, v.selected])).toEqual([
      ['White', true],
      ['Black', false],
      ['Olive', false],
    ]);
    // The mock store has no photos or review summary: reported missing, not invented.
    expect(p?.missing).toEqual(['images', 'reviews.summary_text', 'reviews.histogram']);
  });

  it('lists search results', () => {
    const ctx = open('index.html?q=zentra');
    expect(ctx.products.map((p) => p.id)).toEqual([
      'localhost:zx-buds-air',
      'localhost:zx-pulse-5g',
      'localhost:zx-fit-band-2',
    ]);
    expect(ctx.products[2]?.availability?.status).toBe('out_of_stock');
  });

  it("names each order's buttons t-<action>-<n> so Track C can tie them to ORDER_n", () => {
    const ctx = open('orders.html');
    const ids = ctx.targets.map((t) => [t.id, t.label]);
    expect(ids).toContainEqual(['t-return-1', 'Return item']);
    expect(ids).toContainEqual(['t-track-2', 'Track package']);
    expect(ids).toContainEqual(['t-cancel-2', 'Cancel order']);
    expect(ctx.orders.map((o) => o.id)).toEqual(['ORDER_1', 'ORDER_2']);
  });

  it('extracts orders with placeholder ids only', () => {
    const ctx = open('orders.html');
    expect(ctx.orders.map((o) => [o.status, o.available_actions])).toEqual([
      ['delivered', ['return']],
      ['shipped', ['track', 'cancel']],
    ]);
    expect(ctx.orders[1]?.items[0]).toMatchObject({
      title: 'Zentra Buds Air Wireless Earbuds',
      quantity: 2,
      price: { amount: 3998, currency: 'INR' },
    });
    expect(ctx.orders[0]?.dates).toEqual({
      ordered: '2026-10-01',
      expected_delivery: null,
      delivered: '2026-10-05',
    });
    expect(JSON.stringify(ctx)).not.toMatch(/MS-100\d/);
    expect(resolveOrderId(ctx.orders[0]?.id ?? '')).toBe('MS-1001');
  });
});

describe('mock store checkout summary (what Track C reads before placing an order)', () => {
  function checkoutWithBuds(): PageContext {
    open('product.html?id=zx-buds-air');
    (document.getElementById('add-to-cart') as HTMLButtonElement).click();
    return open('checkout.html');
  }

  it('reads items, totals, PIN, payment and the Place-order target', () => {
    const ctx = checkoutWithBuds();
    expect(schemaErrors('PageContext', ctx)).toEqual([]);
    expect(ctx.checkout).toEqual({
      schema_version: '1.0',
      id: 'CHECKOUT_1',
      items: [
        {
          title: 'Zentra Buds Air Wireless Earbuds (White)',
          quantity: 1,
          price: { amount: 1999, currency: 'INR' },
        },
      ],
      subtotal: { amount: 1999, currency: 'INR' },
      delivery_charge: { amount: 0, currency: 'INR' },
      total: { amount: 1999, currency: 'INR' },
      delivery_pin_code: '500032',
      delivery_address: 'ADDR_1',
      payment_method: 'upi',
      place_order_target_id: 't-place-order',
      missing: [],
    });
    expect(target(ctx, /^Place your order$/).id).toBe('t-place-order');
  });

  it('keeps the address on the device', () => {
    const ctx = checkoutWithBuds();
    expect(JSON.stringify(ctx)).not.toMatch(/Demo User|Demo Street/);
    expect(resolveAddress('ADDR_1')).toBe('Demo User, 12 Demo Street, Hyderabad, PIN 500032');
    expect(restorePlaceholders('Deliver to: ADDR_1.')).toBe(
      'Deliver to: Demo User, 12 Demo Street, Hyderabad, PIN 500032.',
    );
  });

  it('follows the payment choice', async () => {
    const ctx = checkoutWithBuds();
    await performAction(act('select', target(ctx, /^Cash on Delivery$/)));
    expect(extractPageContext(document).checkout?.payment_method).toBe('cod');
  });

  it('an empty cart has no total or Place-order button, so nothing can be placed', () => {
    const ctx = open('checkout.html');
    expect(ctx.checkout).toMatchObject({ total: null, place_order_target_id: null, items: [] });
    expect(ctx.checkout?.missing).toEqual(
      expect.arrayContaining(['total', 'place_order_target_id']),
    );
  });
});

describe('mock store flows through the actuator', () => {
  it('add to cart → checkout → place order (only when confirmed)', async () => {
    let ctx = open('product.html?id=zx-buds-air');
    await performAction(act('click', target(ctx, /^Black$/)));
    await performAction(act('select', target(ctx, /^Quantity/), '2', 'value_set'));
    const added = await performAction(
      act('click', target(ctx, /^Add to Cart$/), null, 'cart_count_increase'),
      { timeoutMs: 300 },
    );
    expect(added).toEqual({ ok: true, performed: true, verified: true });
    expect(state().cart).toEqual([{ id: 'zx-buds-air', qty: 2, colour: 'Black' }]);

    ctx = open('checkout.html');
    const place = target(ctx, /^Place your order$/);
    expect(await performAction(act('click', place))).toMatchObject({
      ok: false,
      reason: 'needs_confirmation',
    });
    expect(state().orders).toHaveLength(2);
    expect((await performAction(act('click', place), { confirmed: true })).performed).toBe(true);
    expect(state().orders[0]).toMatchObject({ id: 'MS-1003', status: 'placed' });
    expect(state().cart).toEqual([]);

    ctx = open('order.html?id=MS-1003&placed=1');
    expect(ctx.orders[0]).toMatchObject({
      status: 'placed',
      available_actions: ['track', 'cancel'],
      items: [{ title: 'Zentra Buds Air Wireless Earbuds', quantity: 2 }],
      dates: { ordered: '2026-10-10', expected_delivery: '2026-10-13', delivered: null },
    });
  });

  it('never types card details: the card fields are a secure zone', async () => {
    open('product.html?id=nx-charger-33w');
    (document.getElementById('add-to-cart') as HTMLButtonElement).click();
    await performAction(act('select', target(open('checkout.html'), /Credit or debit card/)));
    const card = target(extractPageContext(document), /^Card number$/);
    expect(await performAction(act('fill', card, '4111111111111111'))).toMatchObject({
      performed: false,
      reason: 'secure_zone',
    });
    (document.getElementById('cc-number') as HTMLInputElement).focus();
    expect(extractPageContext(document).secure_zone_active).toBe(true);
  });

  it('cancels a shipped order', async () => {
    open('orders.html');
    const ctx = open('order.html?id=MS-1002&do=cancel');
    expect(
      (
        await performAction(
          act('select', target(ctx, /^Reason/), 'Ordered by mistake', 'value_set'),
        )
      ).ok,
    ).toBe(true);
    await performAction(act('click', target(ctx, /^Confirm cancellation$/)));
    expect(state().orders.find((o) => o.id === 'MS-1002')?.status).toBe('cancelled');
    expect(open('orders.html').orders[1]).toMatchObject({
      status: 'cancelled',
      available_actions: [],
    });
  });

  it('returns a delivered order, and asks for a reason first', async () => {
    open('orders.html');
    const ctx = open('order.html?id=MS-1001&do=return');
    await performAction(act('click', target(ctx, /^Confirm return$/)));
    expect(document.getElementById('flow-error')?.textContent).toBe('Please choose a reason.');
    await performAction(act('select', target(ctx, /^Reason/), 'Not as described'));
    await performAction(act('click', target(ctx, /^Confirm return$/)));
    expect(state().orders.find((o) => o.id === 'MS-1001')?.status).toBe('return_requested');
    expect(open('orders.html').orders[0]?.status).toBe('returned');
  });
});
