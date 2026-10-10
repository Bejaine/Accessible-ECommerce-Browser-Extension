// Checkout summary: what the page shows before "Place order" (items, totals, delivery PIN,
// selected payment method, the Place-order button). Read from visible text and labels, so it
// works without per-site selectors. The address leaves the device only as ADDR_n.
import type { CheckoutItem, CheckoutPayment, CheckoutSummary, Money } from '@shared/index';
import { resolveOrderId } from './orders';
import { accessibleName, assignTargetId } from './targets';
import { isHidden, spacedText } from './util';

const registries = new WeakMap<
  Document,
  { byReal: Map<string, string>; byId: Map<string, string> }
>();

function registry(doc: Document) {
  let r = registries.get(doc);
  if (!r) {
    r = { byReal: new Map(), byId: new Map() };
    registries.set(doc, r);
  }
  return r;
}

/** Stable ADDR_n for an address within this document. */
export function addressPlaceholder(doc: Document, address: string): string {
  const r = registry(doc);
  let id = r.byReal.get(address);
  if (!id) {
    id = `ADDR_${r.byReal.size + 1}`;
    r.byReal.set(address, id);
    r.byId.set(id, address);
  }
  return id;
}

/** The real address behind ADDR_n, for reading it aloud on the device. */
export function resolveAddress(placeholder: string, doc: Document = document): string | null {
  return registries.get(doc)?.byId.get(placeholder) ?? null;
}

/** Puts real order ids and addresses back into text received from the backend (on device only). */
export function restorePlaceholders(text: string, doc: Document = document): string {
  return text.replace(
    /\b(ORDER|ADDR)_\d+\b/g,
    (m) => (m.startsWith('ORDER') ? resolveOrderId(m, doc) : resolveAddress(m, doc)) ?? m,
  );
}

const DELIVER_TO = /^(deliver(ing)? to|delivery address|shipping address|ship to)\b\s*:?\s*/i;

/** "Deliver to Demo User, …" in a target label → "Deliver to ADDR_1" (names/addresses are personal). */
export function redactAddress(doc: Document, label: string): string {
  let out = label;
  for (const [real, id] of registry(doc).byReal) out = out.split(real).join(id);
  const m = out.match(DELIVER_TO);
  if (!m) return out;
  const rest = out.slice(m[0].length).trim();
  if (!rest || /^ADDR_\d+$/.test(rest) || /^(change|edit|add)\b/i.test(rest)) return out;
  return `${m[0].trim().replace(/:$/, '')} ${addressPlaceholder(doc, rest)}`;
}

// Labels are followed directly by the amount (or FREE), so "Total savings" never matches.
const AMOUNT_AFTER = String.raw`\s*(\([^)]*\))?\s*:?\s*(?=₹|rs\.?\s|inr|\d|free\b|$)`;
const LABELS = {
  total: new RegExp(
    String.raw`^(order total|grand total|total amount|amount payable|total payable|total to pay|total)${AMOUNT_AFTER}`,
    'i',
  ),
  subtotal: new RegExp(
    String.raw`^(items?( total| subtotal)?|sub-?total|price \(\d+ items?\)|cart total)${AMOUNT_AFTER}`,
    'i',
  ),
  delivery: new RegExp(
    String.raw`^(delivery( charges?| fee)?|shipping( charges?| fee| & handling)?|postage( & packing)?)${AMOUNT_AFTER}`,
    'i',
  ),
};

/** "₹3,998", "Rs. 120", "FREE" (→ 0) at the start of the text; null if no amount. */
function moneyAt(text: string): Money | null {
  const t = text.trim();
  if (/^free\b/i.test(t)) return { amount: 0, currency: 'INR' };
  const m = t.match(/^(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)/i);
  if (!m?.[1]) return null;
  const amount = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(amount) ? { amount, currency: 'INR' } : null;
}

/** Element text; inline elements get spaces around them, so drop the ones before punctuation. */
function tidyText(el: Element): string | null {
  return (
    spacedText(el)
      ?.replace(/\s+([,.;:)])/g, '$1')
      .replace(/\(\s+/g, '(') ?? null
  );
}

/** Visible elements in `root` whose text is short, in document order. */
function shortBlocks(root: Element, max = 160): { el: Element; text: string }[] {
  const out: { el: Element; text: string }[] = [];
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(el.tagName) || isHidden(el)) continue;
    const text = tidyText(el);
    if (text && text.length <= max) out.push({ el, text });
  }
  return out;
}

/** The amount next to a label: in the same element, else in the label's row (parent). */
function labelledMoney(blocks: { el: Element; text: string }[], label: RegExp): Money | null {
  for (const { el, text } of blocks) {
    const m = text.match(label);
    if (!m) continue;
    // Only the innermost element that carries the label.
    if (Array.from(el.children).some((c) => label.test(tidyText(c) ?? ''))) continue;
    const own = moneyAt(text.slice(m[0].length));
    if (own) return own;
    let row = el.parentElement;
    for (let i = 0; i < 2 && row; i++, row = row.parentElement) {
      const rowText = tidyText(row) ?? '';
      if (rowText.length > 160) break;
      const at = rowText.indexOf(text);
      const money = at >= 0 ? moneyAt(rowText.slice(at + text.length).replace(/^\s*:?/, '')) : null;
      if (money) return money;
    }
  }
  return null;
}

const ITEM_LINE =
  /^(.{2,200}?)\s+(?:×|x|qty:?|quantity:?)\s*(\d{1,3})\b\s*(?:[—–-]\s*)?((?:₹|rs\.?|inr)\s*[\d,]+(?:\.\d+)?)?\s*$/i;

function items(blocks: { el: Element; text: string }[]): CheckoutItem[] {
  const out: CheckoutItem[] = [];
  for (const { el, text } of blocks) {
    const m = text.match(ITEM_LINE);
    if (!m?.[1] || !m[2]) continue;
    if (Array.from(el.children).some((c) => ITEM_LINE.test(tidyText(c) ?? ''))) continue;
    out.push({
      title: m[1].trim(),
      quantity: Math.max(1, Number(m[2])),
      price: m[3] ? moneyAt(m[3]) : null,
    });
  }
  return out;
}

const PLACE_ORDER = /^(place (your )?order|confirm (and pay|order)|place order and pay)\b/i;

function placeOrderButton(root: Element): Element | null {
  const candidates = root.querySelectorAll(
    'button, input[type="submit"], input[type="button"], [role="button"], a[href]',
  );
  for (const el of Array.from(candidates)) {
    if (isHidden(el)) continue;
    if (PLACE_ORDER.test(accessibleName(el) ?? '')) return el;
  }
  return null;
}

function paymentFromLabel(label: string): CheckoutPayment {
  if (/\bupi\b|google pay|phonepe|paytm|bhim/i.test(label)) return 'upi';
  if (/cash on delivery|pay on delivery|\bcod\b/i.test(label)) return 'cod';
  if (/net ?banking/i.test(label)) return 'netbanking';
  if (/ending (in|with) \d{4}|[•*x]{2,}\s*\d{4}|saved card/i.test(label)) return 'saved_card';
  if (/\b(credit|debit|card)\b/i.test(label)) return 'card';
  if (/\b(emi|wallet|gift card|pay later)\b/i.test(label)) return 'other';
  return null;
}

/** The payment option the page shows as selected (a checked radio), never any typed value. */
function selectedPayment(root: Element): CheckoutPayment {
  const checked = root.querySelectorAll(
    'input[type="radio"]:checked, [role="radio"][aria-checked="true"]',
  );
  for (const el of Array.from(checked)) {
    const method = paymentFromLabel(accessibleName(el) ?? '');
    if (method) return method;
  }
  return null;
}

const PIN = /\b[1-9]\d{5}\b/;

function delivery(
  doc: Document,
  blocks: { el: Element; text: string }[],
): { address: string | null; pin: string | null } {
  for (const { text } of blocks) {
    const m = text.match(DELIVER_TO);
    if (!m) continue;
    const address = text.slice(m[0].length).trim();
    if (address.length < 5) continue;
    const pin = address.match(PIN)?.[0] ?? null;
    return { address: addressPlaceholder(doc, address), pin };
  }
  return { address: null, pin: null };
}

function pinFromField(root: Element): string | null {
  for (const el of Array.from(root.querySelectorAll('input'))) {
    const isPin =
      el.getAttribute('autocomplete') === 'postal-code' ||
      /\b(pin ?code|pincode|postal code)\b/i.test(accessibleName(el) ?? '');
    const value = (el as HTMLInputElement).value?.trim() ?? '';
    if (isPin && /^[1-9]\d{5}$/.test(value)) return value;
  }
  return null;
}

/** Reads the checkout page; `missing` lists what the page doesn't show. */
export function extractCheckout(doc: Document): CheckoutSummary {
  const root = doc.querySelector('main, [role="main"]') ?? doc.body;
  const blocks = root ? shortBlocks(root) : [];
  const button = root ? placeOrderButton(root) : null;
  const where = delivery(doc, blocks);
  const summary: CheckoutSummary = {
    schema_version: '1.0',
    id: 'CHECKOUT_1',
    items: items(blocks),
    subtotal: labelledMoney(blocks, LABELS.subtotal),
    delivery_charge: labelledMoney(blocks, LABELS.delivery),
    total: labelledMoney(blocks, LABELS.total),
    delivery_pin_code: where.pin ?? (root ? pinFromField(root) : null),
    delivery_address: where.address,
    payment_method: root ? selectedPayment(root) : null,
    place_order_target_id: button ? assignTargetId(button, 't-place-order') : null,
    missing: [],
  };
  const keys = [
    'subtotal',
    'delivery_charge',
    'total',
    'delivery_pin_code',
    'delivery_address',
    'payment_method',
    'place_order_target_id',
  ] as const;
  summary.missing = keys.filter((k) => summary[k] === null);
  if (!summary.items.length) summary.missing.unshift('items');
  return summary;
}
