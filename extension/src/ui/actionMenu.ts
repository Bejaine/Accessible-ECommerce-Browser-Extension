// Action menu (motor): the page's actions from Track B's page map, grouped by zone, as large
// targets in our own overlay. Choosing one goes through the normal turn (onSelect), so
// consequential actions still ask for confirmation; nothing on the shop page is clicked here.
import type { ActionTarget } from '@shared/index';
import { ZONE_ORDER } from './scanGroups';
import { label, type UiKey } from './strings';

export const ACTION_MENU_CSS = `
.asl-actions-menu { display: grid; gap: 12px; }
.asl-actions-menu[hidden] { display: none; }
.asl-actions-menu h3 { margin: 0; font-size: 1em; }
.asl-actions-menu ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.asl-actions-menu li button { inline-size: 100%; min-block-size: 56px; padding: 8px 16px; font: inherit;
  text-align: start; cursor: pointer; border-radius: 10px; color: var(--asl-fg); background: var(--asl-bg);
  border: 2px solid var(--asl-fg); }
.asl-menu-toggle { min-block-size: 44px; padding: 8px 16px; font: inherit; cursor: pointer;
  border-radius: 8px; color: var(--asl-fg); background: var(--asl-bg); border: 2px solid var(--asl-fg); }
`;

/** Per zone, show this many before a "Show more" button. */
export const PER_ZONE = 12;

export interface ActionMenu {
  readonly element: HTMLElement;
  render(targets: ActionTarget[]): void;
}

let ids = 0;

export function createActionMenu(onSelect: (target: ActionTarget) => void): ActionMenu {
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

  let targets: ActionTarget[] = [];
  const expanded = new Set<string>();

  function draw(): void {
    const usable = targets.filter((t) => !t.state?.disabled && t.label.trim());
    toggle.textContent = label('menu.toggle').replace('{count}', String(usable.length));
    toggle.hidden = usable.length === 0;
    const sections = ZONE_ORDER.map((zone) => {
      const inZone = usable.filter((t) => t.zone === zone);
      if (inZone.length === 0) return null;
      const section = document.createElement('section');
      const headingId = `${panelId}-${zone}`;
      section.setAttribute('aria-labelledby', headingId);
      const h = document.createElement('h3');
      h.id = headingId;
      h.textContent = label(`zone.${zone}` as UiKey);
      const list = document.createElement('ul');
      const shown = expanded.has(zone) ? inZone : inZone.slice(0, PER_ZONE);
      for (const target of shown) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent =
          target.colour_name && target.colour_name !== target.label
            ? `${target.label} (${target.colour_name})`
            : target.label;
        b.addEventListener('click', () => onSelect(target));
        li.append(b);
        list.append(li);
      }
      section.append(h, list);
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
    panel.replaceChildren(...sections);
  }

  return {
    element: wrap,
    render(next) {
      targets = next;
      draw();
    },
  };
}
