// Action menu (motor): the page's actions from Track B's page map as large targets in our own
// overlay. Choosing one goes through the normal turn (onSelect), so consequential actions still
// ask for confirmation; nothing on the shop page is clicked here.
//
// Curated (src/ui/pageActions.ts): one entry per destination, no price- or count-only labels.
// "Main actions" first: the controls of the product, cart, checkout and orders areas (Add to
// cart, Buy now, quantity, colours and sizes, Place order) rather than links. Everything else
// (breadcrumbs, recommendations, footer links) sits behind "More on this page", by area.
import type { ActionTarget } from '@shared/index';
import { ACTION_ZONE_ORDER, curateTargets } from './pageActions';
import { label, type UiKey } from './strings';

export const ACTION_MENU_CSS = `
.asl-actions-menu { display: grid; gap: 12px; padding-block: 4px; }
.asl-actions-menu[hidden], .asl-actions-more[hidden] { display: none; }
.asl-actions-menu h3, .asl-actions-menu h4 { margin: 0; font-size: 0.875em; color: var(--asl-muted); }
.asl-actions-more { display: grid; gap: 12px; }
.asl-actions-menu ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.asl-actions-menu li button { inline-size: 100%; min-block-size: 48px; padding: 8px 12px; font: inherit;
  text-align: start; cursor: pointer; border-radius: 10px; color: var(--asl-fg);
  background: var(--asl-tile, var(--asl-bg)); border: 1px solid var(--asl-line-strong, var(--asl-fg)); }
.asl-menu-toggle { min-block-size: 44px; padding: 8px 16px; font: inherit; cursor: pointer;
  border-radius: 8px; color: var(--asl-fg); background: var(--asl-bg); border: 2px solid var(--asl-fg); }
@media (prefers-contrast: more) { .asl-actions-menu li button { border: 2px solid var(--asl-fg); } }
`;

/** Per area under "More on this page", this many before a "Show more" button. */
export const PER_ZONE = 6;
/** At most this many main actions. */
export const MAX_MAIN = 10;

const MAIN_ZONES = new Set(['product', 'cart', 'checkout', 'orders']);

/** The page's own controls (not links) in the areas where shopping happens. */
export function isMainAction(t: ActionTarget): boolean {
  return MAIN_ZONES.has(t.zone) && t.kind !== 'link' && t.kind !== 'other';
}

export interface ActionMenuOptions {
  /** A link target's address on the page (to merge links to the same place). */
  hrefOf?: (id: string) => string | null;
  /** Text as shown (e.g. ADDR_1 back to the address, on the device). */
  display?: (text: string) => string;
}

export interface ActionMenu {
  readonly element: HTMLElement;
  /** The curated actions, main ones first (also what switch scanning offers). */
  readonly actions: ActionTarget[];
  render(targets: ActionTarget[]): void;
}

let ids = 0;

export function createActionMenu(
  onSelect: (target: ActionTarget) => void,
  opts: ActionMenuOptions = {},
): ActionMenu {
  const display = opts.display ?? ((text: string) => text);
  const wrap = document.createElement('div');
  const panelId = `asl-actions-${++ids}`;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'asl-menu-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', panelId);
  const panel = document.createElement('section');
  panel.id = panelId;
  panel.className = 'asl-actions-menu';
  panel.setAttribute('aria-label', label('menu.title'));
  panel.hidden = true;
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });
  wrap.append(toggle, panel);

  let actions: ActionTarget[] = [];
  const expanded = new Set<string>();
  let moreOpen = false;

  function list(targets: ActionTarget[]): HTMLUListElement {
    const ul = document.createElement('ul');
    for (const target of targets) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      const text = display(target.label);
      b.textContent =
        target.colour_name && target.colour_name !== target.label
          ? `${text} (${target.colour_name})`
          : text;
      b.addEventListener('click', () => onSelect(target));
      li.append(b);
      ul.append(li);
    }
    return ul;
  }

  function titled(tag: 'h3' | 'h4', text: string, id: string, ...rest: HTMLElement[]) {
    const section = document.createElement('section');
    section.setAttribute('aria-labelledby', id);
    const h = document.createElement(tag);
    h.id = id;
    h.textContent = text;
    section.append(h, ...rest);
    return section;
  }

  function draw(): void {
    toggle.textContent = label('menu.toggle').replace('{count}', String(actions.length));
    toggle.hidden = actions.length === 0;
    const main = actions.filter(isMainAction).slice(0, MAX_MAIN);
    const rest = actions.filter((t) => !main.includes(t));

    const zoneSections = ACTION_ZONE_ORDER.map((zone) => {
      const inZone = rest.filter((t) => t.zone === zone);
      if (inZone.length === 0) return null;
      const headingId = `${panelId}-${zone}`;
      const shown = expanded.has(zone) ? inZone : inZone.slice(0, PER_ZONE);
      const section = titled(
        main.length > 0 ? 'h4' : 'h3',
        label(`zone.${zone}` as UiKey),
        headingId,
        list(shown),
      );
      if (shown.length < inZone.length) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'asl-menu-toggle';
        more.textContent = label('menu.more').replace(
          '{count}',
          String(inZone.length - shown.length),
        );
        more.addEventListener('click', () => {
          expanded.add(zone);
          draw();
          panel
            .querySelector<HTMLButtonElement>(
              `#${headingId} + ul li:nth-child(${shown.length + 1}) button`,
            )
            ?.focus();
        });
        section.append(more);
      }
      return section;
    }).filter((s): s is HTMLElement => s !== null);

    if (main.length === 0) {
      // Nothing that is clearly "the" action (e.g. search results): the areas directly.
      panel.replaceChildren(...zoneSections);
      return;
    }
    const children: HTMLElement[] = [
      titled('h3', label('menu.main'), `${panelId}-main`, list(main)),
    ];
    if (zoneSections.length > 0) {
      const moreId = `${panelId}-more`;
      const moreToggle = document.createElement('button');
      moreToggle.type = 'button';
      moreToggle.className = 'asl-menu-toggle';
      moreToggle.textContent = label('menu.more_page').replace('{count}', String(rest.length));
      moreToggle.setAttribute('aria-expanded', String(moreOpen));
      moreToggle.setAttribute('aria-controls', moreId);
      const more = document.createElement('div');
      more.id = moreId;
      more.className = 'asl-actions-more';
      more.hidden = !moreOpen;
      more.append(...zoneSections);
      moreToggle.addEventListener('click', () => {
        moreOpen = !moreOpen;
        more.hidden = !moreOpen;
        moreToggle.setAttribute('aria-expanded', String(moreOpen));
      });
      children.push(moreToggle, more);
    }
    panel.replaceChildren(...children);
  }

  return {
    element: wrap,
    get actions() {
      return actions;
    },
    render(next) {
      const curated = curateTargets(next, opts.hrefOf);
      actions = [...curated.filter(isMainAction), ...curated.filter((t) => !isMainAction(t))];
      draw();
    },
  };
}
