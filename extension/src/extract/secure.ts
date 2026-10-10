// Secure zone (docs/safety.md): password, card, CVV, expiry, OTP and UPI PIN fields, and
// payment-gateway / 3-D Secure iframes. While focus is inside one, the mic is muted, nothing is
// extracted and the actuator refuses to type there. Values are never read, only attributes.
import { clean } from './util';

const SECURE_AUTOCOMPLETE = new Set([
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-name',
  'cc-type',
]);

/** Words in a field's name, id, label or placeholder that mark it as a credential. */
const SECURE_WORDS =
  /\b(card ?(number|no)|credit card|debit card|cvv|cvc|csc|security code|expiry|expiration|exp(iry)? date|valid thru|otp|one[- ]time (password|code)|verification code|upi ?pin|m-?pin|atm ?pin|pin|password|passcode|net ?banking)\b/i;

/** Payment gateways and bank 3-D Secure pages that open in iframes. */
const PAYMENT_FRAME =
  /razorpay|payu|juspay|billdesk|ccavenue|paytm|phonepe|cashfree|stripe|paypal|braintree|adyen|checkout\.com|cardinalcommerce|3ds|threeds|acs\.|securepay|netbanking|wibmo|enstage|hdfcbank|icicibank|sbi\.co|axisbank|kotak/i;

function describe(el: Element): string {
  const doc = el.ownerDocument;
  const id = el.getAttribute('id');
  const label = id ? doc.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
  return [
    el.getAttribute('name'),
    id,
    el.getAttribute('placeholder'),
    el.getAttribute('aria-label'),
    el.getAttribute('title'),
    clean(label?.textContent),
    clean(el.closest('label')?.textContent),
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/[_-]+/g, ' ');
}

/** True for an input or frame where credentials are typed. Never looks at the value. */
export function isSecureElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'iframe' || tag === 'frame') {
    const src = el.getAttribute('src') ?? '';
    const name = `${el.getAttribute('name') ?? ''} ${el.getAttribute('title') ?? ''}`;
    return PAYMENT_FRAME.test(src) || /payment|card|3-?d ?secure|otp/i.test(name);
  }
  if (tag !== 'input' && tag !== 'textarea' && el.getAttribute('contenteditable') !== 'true') {
    return false;
  }
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (type === 'password') return true;
  if (['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio'].includes(type)) {
    return false;
  }
  const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
  if (autocomplete.some((t) => SECURE_AUTOCOMPLETE.has(t))) return true;
  // "PIN code" in India is the postal code: an address field, not a credential.
  const words = describe(el).replace(/\bpin ?codes?\b|\bpostal\b|\bzip\b/gi, ' ');
  return SECURE_WORDS.test(words);
}

/** Where focus is right now: inside a secure field or a payment iframe. */
export function isSecureZoneActive(doc: Document = document): boolean {
  return isSecureElement(doc.activeElement);
}

export interface SecureZoneHandlers {
  /** Focus entered a secure field: mute the mic, stop recording, announce it. */
  onEnter(): void;
  /** Focus left: unmute and resume. */
  onLeave(): void;
}

export interface SecureZoneWatcher {
  readonly active: boolean;
  stop(): void;
}

/**
 * Watches focus and calls onEnter/onLeave on each transition. Focus moving into a cross-origin
 * iframe shows up as window blur with the iframe as activeElement, so that is checked too.
 * Listeners are passive and cheap; call stop() on teardown.
 */
export function watchSecureZone(doc: Document, handlers: SecureZoneHandlers): SecureZoneWatcher {
  let active = false;
  const check = (): void => {
    const now = isSecureZoneActive(doc);
    if (now === active) return;
    active = now;
    if (now) handlers.onEnter();
    else handlers.onLeave();
  };
  // focusout fires before the next element is focused; re-check after the move settles.
  const later = (): void => void setTimeout(check, 0);
  const win = doc.defaultView;
  doc.addEventListener('focusin', check, { capture: true, passive: true });
  doc.addEventListener('focusout', later, { capture: true, passive: true });
  win?.addEventListener('blur', later, { passive: true });
  win?.addEventListener('focus', later, { passive: true });
  check();
  return {
    get active() {
      return active;
    },
    stop() {
      doc.removeEventListener('focusin', check, { capture: true });
      doc.removeEventListener('focusout', later, { capture: true });
      win?.removeEventListener('blur', later);
      win?.removeEventListener('focus', later);
    },
  };
}

/** Wires the watcher to anything with mute()/unmute() (Track A's Mic). */
export function muteMicInSecureZone(
  doc: Document,
  mic: { mute(): void; unmute(): void },
  announce?: (event: 'entered' | 'left') => void,
): SecureZoneWatcher {
  return watchSecureZone(doc, {
    onEnter() {
      mic.mute();
      announce?.('entered');
    },
    onLeave() {
      mic.unmute();
      announce?.('left');
    },
  });
}
