// Performs ClientActions in the user's tab (Track B) and checks that they worked.
// Safety (docs/safety.md, rule 2): never types into secure fields, never presses a
// place-order/pay control unless the action came from a confirmed Confirmation.
import type { ClientAction, ExpectedEffect } from '@shared/index';
import { isSecureElement } from '../extract/secure';
import { resolveTarget } from '../extract/targets';

export type ActionFailure =
  | 'target_not_found'
  | 'target_disabled'
  | 'secure_zone'
  | 'needs_confirmation'
  | 'unsupported'
  | 'option_not_found'
  | 'bad_url'
  | 'effect_not_seen';

export interface ActionResult {
  /** The action ran and its expected effect was seen. */
  ok: boolean;
  /** The action itself ran (click dispatched, value set, navigation started). */
  performed: boolean;
  /** The expected effect was seen; null when there was nothing to check. */
  verified: boolean | null;
  reason?: ActionFailure;
}

export interface PerformOptions {
  doc?: Document;
  /** True only for Confirmation.pending_actions after the user said yes. */
  confirmed?: boolean;
  /** How long to wait for the expected effect (default 4 s). */
  timeoutMs?: number;
  /** Navigation hook (tests); defaults to location.assign. */
  navigate?: (url: string) => void;
}

/** Controls that commit money or an order: pressed only after an explicit confirmation. */
const COMMITTING =
  /\b(place (your )?order|confirm (and pay|order|purchase)|pay( now| ₹| rs)?|buy now|proceed to pay(ment)?|complete (purchase|order)|make payment|submit order)\b/i;

function labelOf(el: Element): string {
  return [
    el.getAttribute('aria-label'),
    el.getAttribute('value'),
    el.getAttribute('title'),
    el.textContent,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDisabled(el: Element): boolean {
  return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
}

/** Cart badge count, from the shops' own badges or any labelled cart link. */
export function readCartCount(doc: Document): number | null {
  const badge = doc.querySelector(
    '#nav-cart-count, [data-cart-count], [data-testid="cart-count"], .cart-count, [aria-label*="cart" i] .count',
  );
  const fromBadge = badge?.getAttribute('data-cart-count') ?? badge?.textContent;
  const m = fromBadge?.match(/\d+/);
  if (m) return Number(m[0]);
  for (const a of Array.from(doc.querySelectorAll('a[href*="cart" i], [aria-label*="cart" i]'))) {
    const label = `${a.getAttribute('aria-label') ?? ''} ${a.textContent ?? ''}`;
    const n = label.match(/(\d+)\s*items?\b/i) ?? label.match(/\bcart\D{0,3}(\d+)\b/i);
    if (n?.[1]) return Number(n[1]);
  }
  return null;
}

/** React/Vue-safe value change: native setter, then input + change events. */
function setValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const win = el.ownerDocument.defaultView;
  const proto =
    el.tagName === 'SELECT'
      ? win?.HTMLSelectElement.prototype
      : el.tagName === 'TEXTAREA'
        ? win?.HTMLTextAreaElement.prototype
        : win?.HTMLInputElement.prototype;
  const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : undefined;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function click(el: Element): void {
  const win = el.ownerDocument.defaultView;
  (el as HTMLElement).scrollIntoView?.({ block: 'center' });
  (el as HTMLElement).focus?.();
  const Pointer = win?.PointerEvent ?? win?.MouseEvent;
  if (Pointer) {
    el.dispatchEvent(new Pointer('pointerdown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Pointer('pointerup', { bubbles: true, cancelable: true }));
  }
  (el as HTMLElement).click();
}

type Snapshot = { url: string; cart: number | null };

function effectTarget(
  doc: Document,
  effect: ExpectedEffect,
  fallback: Element | null,
): () => boolean {
  const detail = effect.detail?.trim();
  if (!detail) return () => !!fallback?.isConnected;
  // A CSS selector, or otherwise text that should be on the page.
  if (/^[#.[]/.test(detail)) {
    return () => {
      try {
        return doc.querySelector(detail) != null;
      } catch {
        return false;
      }
    };
  }
  const needle = detail.toLowerCase();
  return () => (doc.body?.textContent ?? '').toLowerCase().includes(needle);
}

function check(
  doc: Document,
  action: ClientAction,
  target: Element | null,
  before: Snapshot,
  present: () => boolean,
): boolean | null {
  const { kind, detail } = action.expected_effect;
  switch (kind) {
    case 'none':
      return null;
    case 'cart_count_increase': {
      const now = readCartCount(doc);
      return now != null && (before.cart == null ? now > 0 : now > before.cart);
    }
    case 'url_change': {
      const href = doc.location?.href ?? '';
      return detail ? href.includes(detail) : href !== before.url;
    }
    case 'element_appears':
      return present();
    case 'element_disappears':
      return !present();
    case 'value_set': {
      const el = target as HTMLInputElement | null;
      return !!el && el.value === (action.value ?? '');
    }
  }
}

/** Waits until the effect is seen, the DOM settles without it, or the timeout passes. */
function waitFor(
  doc: Document,
  test: () => boolean | null,
  timeoutMs: number,
): Promise<boolean | null> {
  return new Promise((resolve) => {
    const first = test();
    if (first !== false) return resolve(first);
    const win = doc.defaultView;
    const Observer = win?.MutationObserver;
    let done = false;
    const finish = (value: boolean | null): void => {
      if (done) return;
      done = true;
      observer?.disconnect();
      clearInterval(poll);
      clearTimeout(timer);
      resolve(value);
    };
    const observer = Observer ? new Observer(() => test() && finish(true)) : null;
    observer?.observe(doc, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    // URL changes and async badge updates don't always mutate the DOM we observe.
    const poll = setInterval(() => test() && finish(true), 150);
    const timer = setTimeout(() => finish(test()), timeoutMs);
  });
}

function fail(reason: ActionFailure, performed = false): ActionResult {
  return { ok: false, performed, verified: performed ? false : null, reason };
}

export async function performAction(
  action: ClientAction,
  opts: PerformOptions = {},
): Promise<ActionResult> {
  const doc = opts.doc ?? document;
  const target = action.target_id ? resolveTarget(action.target_id, doc) : null;
  if (action.target_id && !target) return fail('target_not_found');
  if (target && isDisabled(target)) return fail('target_disabled');
  if (target && isSecureElement(target) && action.type !== 'scroll') return fail('secure_zone');
  if (target && action.type === 'click' && COMMITTING.test(labelOf(target)) && !opts.confirmed) {
    return fail('needs_confirmation');
  }

  const present = effectTarget(doc, action.expected_effect, target);
  const before: Snapshot = {
    url: doc.location?.href ?? '',
    cart: readCartCount(doc),
  };

  switch (action.type) {
    case 'click': {
      if (!target) return fail('target_not_found');
      click(target);
      break;
    }
    case 'fill': {
      const tag = target?.tagName;
      if (!target || (tag !== 'INPUT' && tag !== 'TEXTAREA')) return fail('unsupported');
      (target as HTMLElement).focus?.();
      setValue(target as HTMLInputElement, action.value ?? '');
      break;
    }
    case 'select': {
      if (!target) return fail('target_not_found');
      if (target.tagName === 'SELECT') {
        const select = target as HTMLSelectElement;
        const want = (action.value ?? '').trim().toLowerCase();
        const option = Array.from(select.options).find(
          (o) => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want,
        );
        if (!option) return fail('option_not_found');
        setValue(select, option.value);
      } else {
        // Radios, checkboxes, swatches and variant buttons are selected by clicking them.
        click(target);
      }
      break;
    }
    case 'navigate': {
      let url: URL;
      try {
        url = new URL(action.value ?? '', doc.location?.href);
      } catch {
        return fail('bad_url');
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail('bad_url');
      (opts.navigate ?? ((u: string) => doc.defaultView?.location.assign(u)))(url.href);
      break;
    }
    case 'scroll': {
      if (target) (target as HTMLElement).scrollIntoView?.({ block: 'center' });
      else {
        const win = doc.defaultView;
        const step = (win?.innerHeight ?? 600) * 0.8;
        win?.scrollBy?.({ top: action.value === 'up' ? -step : step, behavior: 'smooth' });
      }
      break;
    }
  }

  const verified = await waitFor(
    doc,
    () => check(doc, action, target, before, present),
    opts.timeoutMs ?? 4000,
  );
  if (verified === false)
    return { ok: false, performed: true, verified: false, reason: 'effect_not_seen' };
  return { ok: true, performed: true, verified };
}
