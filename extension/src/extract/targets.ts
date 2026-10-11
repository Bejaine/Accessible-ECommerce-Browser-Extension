// Page map: the interactive elements of the page as ActionTargets {id, kind, label, zone, …}.
// Element references stay in this module's registry; only the ids travel to the backend, and
// the actuator turns an id back into an element with resolveTarget().
import type { ActionTarget, PageType, TargetKind, Zone } from '@shared/index';
import { clean, isHidden, meaningfulAlt, spacedText } from './util';

interface Registry {
  byElement: WeakMap<Element, string>;
  byId: Map<string, WeakRef<Element>>;
  next: number;
}

const registries = new WeakMap<Document, Registry>();

function registry(doc: Document): Registry {
  let r = registries.get(doc);
  if (!r) {
    r = { byElement: new WeakMap(), byId: new Map(), next: 1 };
    registries.set(doc, r);
  }
  return r;
}

/** Stable id for an element within this document's lifetime ("t1", "t2", …). */
export function targetIdFor(el: Element): string {
  const r = registry(el.ownerDocument);
  let id = r.byElement.get(el);
  if (!id) {
    id = `t${r.next++}`;
    r.byElement.set(el, id);
    r.byId.set(id, new WeakRef(el));
  }
  return id;
}

/**
 * Gives an element a meaningful id (e.g. "t-cancel-2" for ORDER_2's cancel button, the
 * convention Track C's workflows use to tie a button to its order). Falls back to the generic
 * id if another live element already holds that name. The old id keeps resolving.
 */
export function assignTargetId(el: Element, preferred: string): string {
  const r = registry(el.ownerDocument);
  if (r.byElement.get(el) === preferred) return preferred;
  const holder = r.byId.get(preferred)?.deref();
  if (holder && holder !== el && holder.isConnected) return targetIdFor(el);
  r.byElement.set(el, preferred);
  r.byId.set(preferred, new WeakRef(el));
  return preferred;
}

/** The element behind a target id, or null if it is gone. */
export function resolveTarget(id: string, doc: Document = document): Element | null {
  const el = registries.get(doc)?.byId.get(id)?.deref() ?? null;
  return el && el.isConnected ? el : null;
}

const INTERACTIVE = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="menuitem"]',
].join(', ');

const MAX_TARGETS = 200;
const MAX_LABEL = 120;

function textWithAlt(el: Element | null): string | null {
  if (!el) return null;
  return spacedText(el) ?? meaningfulAlt(el.querySelector('img[alt]'));
}

/** A label's text without the control inside it (a select's options are not its name). */
function labelText(label: Element | null, control: Element): string | null {
  if (!label) return null;
  const parts: string[] = [];
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child === control) continue;
      if (child.nodeType === 3) parts.push(child.textContent ?? '');
      else if (child.nodeType === 1) walk(child);
    }
  };
  walk(label);
  return clean(parts.join(' '));
}

/** A practical subset of the accessible-name algorithm. */
export function accessibleName(el: Element): string | null {
  const doc = el.ownerDocument;
  const aria = clean(el.getAttribute('aria-label'));
  if (aria) return aria;
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const parts = labelledby
      .split(/\s+/)
      .map((id) => textWithAlt(doc.getElementById(id)))
      .filter((t): t is string => !!t);
    if (parts.length) return parts.join(' ');
  }
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const id = el.getAttribute('id');
    const forLabel = id ? doc.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const label = labelText(forLabel, el) ?? labelText(el.closest('label'), el);
    if (label) return label;
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (['submit', 'button', 'reset'].includes(type)) {
      const value = clean(el.getAttribute('value'));
      if (value) return value;
    }
    if (type === 'image') return clean(el.getAttribute('alt'));
    return (
      clean(el.getAttribute('placeholder')) ??
      clean(el.getAttribute('title')) ??
      clean(el.getAttribute('name'))
    );
  }
  return textWithAlt(el) ?? clean(el.getAttribute('title'));
}

function kindOf(el: Element): TargetKind {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  const type = (el.getAttribute('type') ?? 'text').toLowerCase();
  if (isSwatch(el)) return 'swatch';
  if (tag === 'select') return 'select';
  if (tag === 'textarea') return 'input';
  if (tag === 'input') {
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (['submit', 'button', 'reset', 'image'].includes(type))
      return role === 'radio' ? 'radio' : 'button';
    return 'input';
  }
  if (role === 'checkbox' || role === 'switch') return 'checkbox';
  if (role === 'radio') return 'radio';
  if (tag === 'button' || role === 'button') return 'button';
  if (tag === 'a' || role === 'link') return 'link';
  return 'other';
}

/** Colour swatches: a control inside a colour picker that shows an image or colour name. */
function isSwatch(el: Element): boolean {
  return !!el.closest(
    '[id*="color_name"], [id*="colour_name"], [data-colour-swatch], [class*="color-swatch"]',
  );
}

function colourName(el: Element, label: string): string | null {
  if (!isSwatch(el)) return null;
  const host = el.closest('li') ?? el;
  return (
    clean(host.querySelector('img[alt]')?.getAttribute('alt')) ??
    clean(el.getAttribute('title')) ??
    label
  );
}

const PAGE_ZONE: Record<PageType, Zone> = {
  search: 'results',
  product: 'product',
  reviews: 'product',
  cart: 'cart',
  checkout: 'checkout',
  orders: 'orders',
  order_detail: 'orders',
  other: 'results',
};

function zoneOf(el: Element, pageType: PageType): Zone {
  const href = el.getAttribute('href') ?? '';
  if (/\/(gp\/cart|cart|viewcart)\b/i.test(href)) return 'cart';
  if (
    el.closest('[role="search"], form[action*="search"], form[action="/s"], #nav-search') ||
    /^(q|k|field-keywords)$/.test(el.getAttribute('name') ?? '') ||
    el.getAttribute('type') === 'search'
  ) {
    return 'search';
  }
  if (
    el.closest(
      'header, nav, footer, [role="navigation"], [role="contentinfo"], [role="banner"], #navbar, #navFooter',
    )
  ) {
    return 'help';
  }
  return PAGE_ZONE[pageType];
}

// Search and cart hold only a few controls but must never be cut by the cap.
const ZONE_PRIORITY: Zone[] = [
  'search',
  'cart',
  'product',
  'results',
  'checkout',
  'orders',
  'help',
];

export interface PageMapOptions {
  pageType: PageType;
  url: string;
  /** Elements that must survive the cap (e.g. the checkout's Place-order button). */
  pinned?: Element[];
}

/**
 * Visible, labelled interactive elements, most relevant zones first, capped at MAX_TARGETS.
 * Never reads input values (labels only), so it is safe next to payment fields.
 */
export function buildPageMap(doc: Document, opts: PageMapOptions): ActionTarget[] {
  const seen = new Set<string>();
  const found: ActionTarget[] = [];
  const pinnedIds = new Set((opts.pinned ?? []).map((el) => targetIdFor(el)));
  for (const el of Array.from(doc.querySelectorAll(INTERACTIVE))) {
    if (isHidden(el)) continue;
    const href = el.getAttribute('href');
    if (href && /^javascript:/i.test(href) && !el.getAttribute('role')) continue;
    const name = accessibleName(el);
    if (!name) continue;
    const label = name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1)}…` : name;
    const kind = kindOf(el);
    const key = `${kind}|${label}|${href ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      schema_version: '1.0',
      id: targetIdFor(el),
      kind,
      label,
      zone: zoneOf(el, opts.pageType),
      state: {
        disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
        selected:
          ['aria-selected', 'aria-checked', 'aria-pressed'].some(
            (a) => el.getAttribute(a) === 'true',
          ) || el.hasAttribute('checked'),
        expanded: el.getAttribute('aria-expanded') === 'true',
      },
      colour_name: colourName(el, label),
    });
  }
  const rank = (t: ActionTarget): number =>
    pinnedIds.has(t.id) ? -1 : ZONE_PRIORITY.indexOf(t.zone);
  return found
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .slice(0, MAX_TARGETS)
    .map(({ t }) => t);
}
