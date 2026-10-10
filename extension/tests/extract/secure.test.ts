import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractPageContext,
  isSecureElement,
  muteMicInSecureZone,
  watchSecureZone,
} from '../../src/extract';
import { buildLlmFallbackRequest } from '../../src/extract/llm';

function field(html: string): Element {
  // Iframes go in an inert <template> so the test DOM never tries to load them.
  const root: ParentNode = html.startsWith('<iframe')
    ? Object.assign(document.createElement('template'), { innerHTML: html }).content
    : Object.assign(document.body, { innerHTML: html });
  const el = root.querySelector('input, textarea, iframe');
  if (!el) throw new Error('no field');
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('secure field detection', () => {
  it.each([
    '<input type="password">',
    '<input autocomplete="cc-number">',
    '<input autocomplete="cc-csc">',
    '<input autocomplete="one-time-code">',
    '<input name="cvv">',
    '<input placeholder="Card Number">',
    '<input aria-label="Enter OTP">',
    '<label for="u">UPI PIN</label><input id="u">',
    '<label>Expiry date <input></label>',
    '<iframe src="https://api.razorpay.com/v1/checkout"></iframe>',
    '<iframe title="3-D Secure authentication" src="https://bank.example/auth"></iframe>',
  ])('secure: %s', (html) => {
    expect(isSecureElement(field(html))).toBe(true);
  });

  it.each([
    '<input name="q" placeholder="Search Amazon.in">',
    '<input name="pincode" placeholder="Enter delivery PIN code">',
    '<label for="p">Pin code</label><input id="p">',
    '<input name="quantity">',
    '<input type="submit" value="Proceed to pay">',
    '<iframe src="https://www.youtube.com/embed/x"></iframe>',
  ])('not secure: %s', (html) => {
    expect(isSecureElement(field(html))).toBe(false);
  });
});

describe('secure zone watcher', () => {
  it('mutes on entering a secure field and unmutes on leaving, once per transition', async () => {
    document.body.innerHTML =
      '<input id="name" name="fullname"><input id="cvv" name="cvv"><input id="otp" autocomplete="one-time-code">';
    const mic = { mute: vi.fn(), unmute: vi.fn() };
    const announce = vi.fn();
    const watcher = muteMicInSecureZone(document, mic, announce);
    const focus = async (id: string): Promise<void> => {
      (document.getElementById(id) as HTMLInputElement).focus();
      await new Promise((r) => setTimeout(r, 5));
    };

    await focus('name');
    expect(mic.mute).not.toHaveBeenCalled();
    await focus('cvv');
    expect(mic.mute).toHaveBeenCalledTimes(1);
    expect(watcher.active).toBe(true);
    await focus('otp'); // secure → secure: no extra transition
    expect(mic.mute).toHaveBeenCalledTimes(1);
    await focus('name');
    expect(mic.unmute).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls).toEqual([['entered'], ['left']]);
    watcher.stop();
  });

  it('stops listening after stop()', async () => {
    document.body.innerHTML = '<input id="pw" type="password">';
    const onEnter = vi.fn();
    watchSecureZone(document, { onEnter, onLeave: vi.fn() }).stop();
    (document.getElementById('pw') as HTMLInputElement).focus();
    await new Promise((r) => setTimeout(r, 5));
    expect(onEnter).not.toHaveBeenCalled();
  });
});

describe('extraction in the secure zone', () => {
  it('extracts nothing while focus is in a secure field', () => {
    document.body.innerHTML =
      '<script type="application/ld+json">{"@type":"Product","name":"Mug","sku":"M"}</script>' +
      '<button>Pay</button><input id="card" autocomplete="cc-number" value="4111111111111111">';
    (document.getElementById('card') as HTMLInputElement).focus();
    const ctx = extractPageContext(document, { url: 'https://shop.test/p/mug' });
    expect(ctx.secure_zone_active).toBe(true);
    expect(ctx.products).toEqual([]);
    expect(ctx.targets).toEqual([]);
  });

  it('never puts payment iframes or field values into the LLM text', () => {
    const doc = new DOMParser().parseFromString(
      '<main><h1>Mug</h1><p>Nice mug</p><input value="4111 1111 1111 1111"><iframe title="Payment"></iframe></main>',
      'text/html',
    );
    const req = buildLlmFallbackRequest(doc, 'https://shop.test/p/mug', ['seller']);
    expect(req.text).toBe('Mug\nNice mug');
  });
});
