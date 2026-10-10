import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientAction, EffectKind } from '@shared/index';
import { performAction, readCartCount } from '../src/actuate';
import { targetIdFor } from '../src/extract/targets';

function action(
  type: ClientAction['type'],
  el: Element | null,
  value: string | null = null,
  kind: EffectKind = 'none',
  detail: string | null = null,
): ClientAction {
  return {
    schema_version: '1.0',
    id: 'a1',
    type,
    target_id: el ? targetIdFor(el) : null,
    value,
    expected_effect: { kind, detail },
  };
}

function $(selector: string): Element {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`no ${selector}`);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('click', () => {
  it('clicks and verifies the cart count went up', async () => {
    document.body.innerHTML =
      '<span id="nav-cart-count">1</span><button id="add">Add to cart</button>';
    $('#add').addEventListener('click', () => {
      setTimeout(() => ($('#nav-cart-count').textContent = '2'), 30);
    });
    const r = await performAction(action('click', $('#add'), null, 'cart_count_increase'), {
      timeoutMs: 500,
    });
    expect(r).toEqual({ ok: true, performed: true, verified: true });
  });

  it('reports when the expected effect never happens', async () => {
    document.body.innerHTML =
      '<span id="nav-cart-count">1</span><button id="add">Add to cart</button>';
    const r = await performAction(action('click', $('#add'), null, 'cart_count_increase'), {
      timeoutMs: 200,
    });
    expect(r).toEqual({ ok: false, performed: true, verified: false, reason: 'effect_not_seen' });
  });

  it('waits for an element (by text or selector) to appear', async () => {
    document.body.innerHTML = '<button id="b">Add to cart</button>';
    $('#b').addEventListener('click', () => {
      setTimeout(
        () => document.body.insertAdjacentHTML('beforeend', '<div id="ok">Added to Cart</div>'),
        20,
      );
    });
    expect(
      (
        await performAction(action('click', $('#b'), null, 'element_appears', 'added to cart'), {
          timeoutMs: 500,
        })
      ).ok,
    ).toBe(true);
  });

  it('refuses Place order / Pay without a confirmation, allows it with one', async () => {
    document.body.innerHTML =
      '<button id="po">Place your order</button><button id="pay">Pay ₹12,999</button>';
    const clicked = vi.fn();
    $('#po').addEventListener('click', clicked);
    expect(await performAction(action('click', $('#po')))).toMatchObject({
      ok: false,
      performed: false,
      reason: 'needs_confirmation',
    });
    expect(await performAction(action('click', $('#pay')))).toMatchObject({
      reason: 'needs_confirmation',
    });
    expect(clicked).not.toHaveBeenCalled();
    expect((await performAction(action('click', $('#po')), { confirmed: true })).ok).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('refuses disabled and unknown targets', async () => {
    document.body.innerHTML = '<button id="d" disabled>Add</button>';
    expect((await performAction(action('click', $('#d')))).reason).toBe('target_disabled');
    const ghost = { ...action('click', null), target_id: 't99999' };
    expect((await performAction(ghost)).reason).toBe('target_not_found');
  });
});

describe('fill', () => {
  it('sets the value React-safely (native setter + input/change events)', async () => {
    document.body.innerHTML = '<input id="q" name="q">';
    const input = $('#q') as HTMLInputElement;
    const seen: string[] = [];
    input.addEventListener('input', () => seen.push(`input:${input.value}`));
    input.addEventListener('change', () => seen.push(`change:${input.value}`));
    // React shadows `value` on the instance; a plain assignment would only hit this.
    let shadow = '';
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () =>
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.get?.call(input),
      set: (v: string) => {
        shadow = v;
      },
    });
    const r = await performAction(action('fill', input, 'wireless earphones', 'value_set'));
    expect(r.ok).toBe(true);
    expect(seen).toEqual(['input:wireless earphones', 'change:wireless earphones']);
    expect(shadow).toBe(''); // went through the native setter, not the instance one
  });

  it('never types into secure fields', async () => {
    document.body.innerHTML = '<input id="c" autocomplete="cc-number">';
    const r = await performAction(action('fill', $('#c'), '4111111111111111'));
    expect(r).toMatchObject({ ok: false, performed: false, reason: 'secure_zone' });
    expect(($('#c') as HTMLInputElement).value).toBe('');
  });
});

describe('select', () => {
  it('picks a <select> option by value or visible text', async () => {
    document.body.innerHTML =
      '<select id="qty"><option value="1">1</option><option value="2">2</option><option value="3">Qty: 3</option></select>';
    const sel = $('#qty') as HTMLSelectElement;
    const changed = vi.fn();
    sel.addEventListener('change', changed);
    expect((await performAction(action('select', sel, 'qty: 3'))).ok).toBe(true);
    expect(sel.value).toBe('3');
    expect(changed).toHaveBeenCalled();
    expect((await performAction(action('select', sel, '7'))).reason).toBe('option_not_found');
  });

  it('selects swatches and radios by clicking them', async () => {
    document.body.innerHTML = '<input type="radio" id="r" name="c" aria-label="Olive">';
    await performAction(action('select', $('#r')));
    expect(($('#r') as HTMLInputElement).checked).toBe(true);
  });
});

describe('navigate', () => {
  it('goes to http(s) URLs, refuses others', async () => {
    const navigate = vi.fn();
    const ok = await performAction(
      action('navigate', null, 'https://www.amazon.in/s?k=earphones'),
      { navigate },
    );
    expect(ok.performed).toBe(true);
    expect(navigate).toHaveBeenCalledWith('https://www.amazon.in/s?k=earphones');
    expect(
      (await performAction(action('navigate', null, 'javascript:alert(1)'), { navigate })).reason,
    ).toBe('bad_url');
  });
});

describe('readCartCount', () => {
  it('reads Amazon, data-attribute and labelled-link badges', () => {
    document.body.innerHTML = '<span id="nav-cart-count">3</span>';
    expect(readCartCount(document)).toBe(3);
    document.body.innerHTML = '<a href="/viewcart" aria-label="Cart, 2 items">Cart</a>';
    expect(readCartCount(document)).toBe(2);
    document.body.innerHTML = '<a href="/help">Help</a>';
    expect(readCartCount(document)).toBeNull();
  });
});
