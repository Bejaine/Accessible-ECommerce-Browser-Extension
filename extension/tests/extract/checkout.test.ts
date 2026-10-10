// Checkout summary on layouts shaped like the real sites' order summaries (label and amount in
// separate cells, savings rows, saved cards). Synthetic markup: real checkout pages need a
// logged-in account and are not in fixtures/pages/ yet.
import { describe, expect, it } from 'vitest';
import { extractCheckout, extractPageContext, resolveAddress } from '../../src/extract';
import { schemaErrors } from './helpers';

function page(html: string): Document {
  return new DOMParser().parseFromString(`<body><main>${html}</main></body>`, 'text/html');
}

describe('extractCheckout', () => {
  it('reads label/amount rows and ignores savings rows', () => {
    const doc = page(`
      <div class="summary">
        <div class="row"><span>Price (2 items)</span><span>₹4,598</span></div>
        <div class="row"><span>Total savings</span><span>₹600</span></div>
        <div class="row"><span>Delivery Charges</span><span>FREE</span></div>
        <div class="row"><span>Total Amount</span><span>₹3,998</span></div>
      </div>
      <button>PLACE ORDER</button>`);
    const c = extractCheckout(doc);
    expect(c).toMatchObject({
      subtotal: { amount: 4598, currency: 'INR' },
      delivery_charge: { amount: 0, currency: 'INR' },
      total: { amount: 3998, currency: 'INR' },
      place_order_target_id: 't-place-order',
    });
    expect(c.missing).toEqual(['items', 'delivery_pin_code', 'delivery_address', 'payment_method']);
  });

  it('reads "Order Total:" with a delivery charge, the address block and a saved card', () => {
    const doc = page(`
      <div><h3>Delivering to</h3></div>
      <p>Deliver to: Asha Rao, 4-1 MG Road, Bengaluru, Karnataka 560001</p>
      <fieldset>
        <label><input type="radio" name="pay" checked> HDFC Bank credit card ending in 4242</label>
        <label><input type="radio" name="pay"> Cash on Delivery/Pay on Delivery</label>
      </fieldset>
      <table>
        <tr><td>Items:</td><td>₹1,299.00</td></tr>
        <tr><td>Delivery:</td><td>₹40.00</td></tr>
        <tr><td>Order Total:</td><td>₹1,339.00</td></tr>
      </table>
      <span role="button">Place your order</span>`);
    const c = extractCheckout(doc);
    expect(c).toMatchObject({
      subtotal: { amount: 1299 },
      delivery_charge: { amount: 40 },
      total: { amount: 1339 },
      delivery_pin_code: '560001',
      delivery_address: 'ADDR_1',
      payment_method: 'saved_card',
    });
    expect(resolveAddress('ADDR_1', doc)).toBe(
      'Asha Rao, 4-1 MG Road, Bengaluru, Karnataka 560001',
    );
  });

  it('a delivery date is not a delivery charge', () => {
    const c = extractCheckout(page('<p>Delivery: Tuesday 13 October</p><p>Order total: ₹500</p>'));
    expect(c.delivery_charge).toBeNull();
    expect(c.total).toEqual({ amount: 500, currency: 'INR' });
  });

  it('skips a hidden Place-order button and reads the PIN from the address form', () => {
    const doc = page(`
      <label>Pincode <input name="pin" value="500032"></label>
      <button hidden>Place order</button>`);
    const c = extractCheckout(doc);
    expect(c.place_order_target_id).toBeNull();
    expect(c.delivery_pin_code).toBe('500032');
  });

  it('PageContext carries the summary and no names from "Deliver to" labels', () => {
    const doc = page(`
      <a href="/addr">Deliver to Asha Rao - Bengaluru 560001</a>
      <p>Order total: ₹500</p><button>Place your order</button>`);
    const ctx = extractPageContext(doc, {
      url: 'https://www.amazon.in/gp/buy/spc/handlers/display.html',
    });
    expect(ctx.page_type).toBe('checkout');
    expect(schemaErrors('PageContext', ctx)).toEqual([]);
    expect(ctx.checkout?.total?.amount).toBe(500);
    // The Place-order button is pinned first so the 200-target cap can never drop it.
    expect(ctx.targets.map((t) => t.label)).toEqual(['Place your order', 'Deliver to ADDR_1']);
    expect(ctx.targets[0]?.id).toBe('t-place-order');
  });

  it('other page types carry no checkout summary', () => {
    const ctx = extractPageContext(page('<p>Order total: ₹500</p>'), {
      url: 'https://www.amazon.in/gp/cart/view.html',
    });
    expect(ctx.checkout).toBeNull();
  });
});
