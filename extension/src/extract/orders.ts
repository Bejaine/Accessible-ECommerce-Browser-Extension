// Orders: OrderJSON with placeholder ids. Real order numbers are personal data (docs/safety.md),
// so the backend only ever sees ORDER_1, ORDER_2…; the mapping stays in this module.
import type { OrderJSON, OrderStatus } from '@shared/index';
import { assignTargetId } from './targets';

/** What an adapter reads for one order; `realId` never leaves the device. */
export interface OrderDraft {
  realId: string;
  items: OrderJSON['items'];
  status: OrderStatus;
  dates: OrderJSON['dates'];
  available_actions: OrderJSON['available_actions'];
  /** The page's controls for this order's actions; they get ids like t-cancel-2 (ORDER_2). */
  actionElements?: { action: 'track' | 'return' | 'cancel'; el: Element }[];
}

interface OrderRegistry {
  byReal: Map<string, string>;
  byPlaceholder: Map<string, string>;
}

const registries = new WeakMap<Document, OrderRegistry>();

function registry(doc: Document): OrderRegistry {
  let r = registries.get(doc);
  if (!r) {
    r = { byReal: new Map(), byPlaceholder: new Map() };
    registries.set(doc, r);
  }
  return r;
}

/** Stable ORDER_n for a real order id within this document. */
export function orderPlaceholder(doc: Document, realId: string): string {
  const r = registry(doc);
  let id = r.byReal.get(realId);
  if (!id) {
    id = `ORDER_${r.byReal.size + 1}`;
    r.byReal.set(realId, id);
    r.byPlaceholder.set(id, realId);
  }
  return id;
}

/** The real order id behind a placeholder, for reading it aloud or finding it on the page. */
export function resolveOrderId(placeholder: string, doc: Document = document): string | null {
  return registries.get(doc)?.byPlaceholder.get(placeholder) ?? null;
}

/** Order-number shapes: Amazon 123-1234567-1234567, Flipkart OD123456789012345. */
export const ORDER_NUMBER = /\b\d{3}-\d{7}-\d{7}\b|\bOD\d{12,}\b/g;

/**
 * Replaces real order numbers in any text that leaves the device (labels, LLM text) with their
 * ORDER_n placeholders: ids already seen on this page, plus anything shaped like one.
 */
export function redactOrderIds(doc: Document, text: string): string {
  let out = text;
  for (const [realId, placeholder] of registry(doc).byReal) {
    if (out.includes(realId)) out = out.split(realId).join(placeholder);
  }
  return out.replace(ORDER_NUMBER, (m) => orderPlaceholder(doc, m));
}

export function toOrderJSON(doc: Document, draft: OrderDraft): OrderJSON {
  const id = orderPlaceholder(doc, draft.realId);
  const n = id.slice('ORDER_'.length);
  for (const { action, el } of draft.actionElements ?? []) assignTargetId(el, `t-${action}-${n}`);
  return {
    schema_version: '1.0',
    id,
    items: draft.items,
    status: draft.status,
    dates: draft.dates,
    available_actions: Array.from(new Set(draft.available_actions)),
  };
}

const STATUS_WORDS: [RegExp, OrderStatus][] = [
  [/\b(return(ed| requested| initiated)|refund(ed)?)\b/i, 'returned'],
  [/\bcancel(l)?ed\b/i, 'cancelled'],
  [/\bout for delivery\b/i, 'out_for_delivery'],
  [/\bdelivered\b/i, 'delivered'],
  [/\b(shipped|dispatched|in transit)\b/i, 'shipped'],
  [/\b(order(ed)? placed|confirmed|preparing|processing)\b/i, 'placed'],
];

/** Maps a shop's status wording ("Arriving Tuesday", "Delivered 5 Oct"…) to OrderStatus. */
export function orderStatusFromText(text: string | null | undefined): OrderStatus {
  if (!text) return 'unknown';
  for (const [re, status] of STATUS_WORDS) if (re.test(text)) return status;
  return 'unknown';
}
