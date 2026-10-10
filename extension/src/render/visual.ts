// AccessibleOutput -> DOM inside the overlay (large-text friendly; sizes follow --asl-scale).
// Text is only ever set with textContent: output can contain LLM-generated strings.
// Pro/con/warning items carry a text label, never colour alone.
import type { AccessibleOutput, ItemKind, Section } from '@shared/index';
import { announce } from '../ui/announce';
import { getUiLang, label, type UiKey } from '../ui/strings';
import { canSimplify } from './speech';

export const RENDER_CSS = `
.asl-output { display: grid; gap: 12px; }
.asl-summary { font-size: 1.125em; font-weight: 600; margin: 0; }
.asl-output ul { margin: 0; padding-inline-start: 1.25em; }
.asl-output li + li { margin-block-start: 4px; }
.asl-output h3 { font-size: 1em; margin: 0 0 4px; }
.asl-output section > p { margin: 0; }
.asl-warnings { border: 2px solid var(--asl-fg); border-radius: 8px; padding: 8px 12px; list-style: none; }
.asl-warnings li, .asl-output ul.asl-warnings { padding-inline-start: 0; }
.asl-badge { font-weight: 700; }
.asl-output table { border-collapse: collapse; inline-size: 100%; }
.asl-output th, .asl-output td { border: 1px solid var(--asl-fg); padding: 4px 8px; text-align: start; }
.asl-output caption { font-weight: 700; text-align: start; margin-block-end: 4px; }
.asl-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.asl-toolbar { display: flex; flex-wrap: wrap; gap: 8px; }
.asl-chips button, .asl-simpler, .asl-toolbar button {
  min-inline-size: 44px; min-block-size: 44px; padding: 8px 14px; cursor: pointer; font: inherit;
  color: var(--asl-fg); background: var(--asl-bg); border: 2px solid var(--asl-fg); border-radius: 22px;
}
.asl-simpler[aria-pressed='true'] { background: var(--asl-fg); color: var(--asl-bg); }
@media (forced-colors: active) {
  .asl-simpler[aria-pressed='true'] { background: Highlight; color: HighlightText; }
}
`;

const BADGE: Partial<Record<ItemKind, UiKey>> = {
  pro: 'render.pro',
  con: 'render.con',
  warning: 'render.warning',
};

export interface RenderOptions {
  /** Start in plain-language mode (when available). */
  simpler?: boolean;
  /** ResolvedMode.max_options: cap on suggestion buttons. */
  maxOptions?: number;
  /** Called with the suggested utterance when a followup chip is chosen. */
  onFollowup?: (text: string) => void;
  /** Shows "Back to menu"; called when it's pressed. */
  onBack?: () => void;
  /** Shows "Read aloud" / "Stop reading"; called with true to start, false to stop. */
  onReadAloud?: (start: boolean) => void;
}

export interface RenderedOutput {
  readonly simpler: boolean;
  setSimpler(on: boolean): void;
  /** Reflect whether the answer is being read aloud (flips Read aloud / Stop reading). */
  setReading(reading: boolean): void;
}

let idCounter = 0;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function renderSection(section: Section, simpler: boolean, lang: string): HTMLElement {
  const headingId = `asl-sec-${++idCounter}`;
  const node = el('section', undefined, { 'aria-labelledby': headingId });
  node.append(el('h3', section.heading, { id: headingId }));

  if (simpler && section.simpler !== null) {
    node.append(el('p', section.simpler));
    return node;
  }
  if (section.items.length > 0) {
    const list = el('ul');
    for (const item of section.items) {
      const li = el('li');
      const badge = BADGE[item.kind];
      if (badge) li.append(el('span', `${label(badge, lang)}: `, { class: 'asl-badge' }));
      li.append(item.text);
      list.append(li);
    }
    node.append(list);
  }
  if (section.table) {
    const table = el('table');
    table.append(el('caption', section.heading));
    const head = el('tr');
    for (const col of section.table.columns) head.append(el('th', col, { scope: 'col' }));
    const thead = el('thead');
    thead.append(head);
    table.append(thead);
    const body = el('tbody');
    for (const row of section.table.rows) {
      const tr = el('tr');
      row.forEach((cell, i) =>
        tr.append(i === 0 ? el('th', cell, { scope: 'row' }) : el('td', cell)),
      );
      body.append(tr);
    }
    table.append(body);
    node.append(table);
  }
  return node;
}

function renderBody(output: AccessibleOutput, simpler: boolean, opts: RenderOptions): HTMLElement {
  const lang = output.lang;
  const body = el('div', undefined, { class: 'asl-output-body' });
  const summary = simpler && output.simpler !== null ? output.simpler : output.summary;
  body.append(el('p', summary, { class: 'asl-summary' }));

  if (output.warnings.length > 0) {
    const list = el('ul', undefined, {
      class: 'asl-warnings',
      'aria-label': label('render.warnings', lang),
    });
    for (const w of output.warnings) {
      const li = el('li');
      li.append(el('span', `${label('render.warning', lang)}: `, { class: 'asl-badge' }), w);
      list.append(li);
    }
    body.append(list);
  }

  for (const section of output.sections) body.append(renderSection(section, simpler, lang));

  const followups = output.followups.slice(0, opts.maxOptions ?? output.followups.length);
  if (followups.length > 0) {
    const chips = el('div', undefined, {
      class: 'asl-chips',
      role: 'group',
      'aria-label': label('render.suggestions', lang),
    });
    for (const text of followups) {
      const button = el('button', text, { type: 'button' });
      button.addEventListener('click', () => opts.onFollowup?.(text));
      chips.append(button);
    }
    body.append(chips);
  }
  return body;
}

/** Replace `container`'s content with a view of `output`. */
export function renderOutput(
  container: HTMLElement,
  output: AccessibleOutput,
  opts: RenderOptions = {},
): RenderedOutput {
  const article = el('article', undefined, { class: 'asl-output', lang: output.lang });
  let simpler = Boolean(opts.simpler) && canSimplify(output);
  let body = renderBody(output, simpler, opts);

  // Toolbar buttons are interface, so they follow the UI language; the answer itself (and its
  // Pro/Con labels) follows the answer's language.
  const toolbar = el('div', undefined, { class: 'asl-toolbar', lang: getUiLang() });
  let reading = false;
  let readButton: HTMLButtonElement | null = null;
  if (opts.onReadAloud) {
    readButton = el('button', label('render.read_aloud'), {
      type: 'button',
      'aria-pressed': 'false',
    });
    readButton.addEventListener('click', () => opts.onReadAloud?.(!reading));
    toolbar.append(readButton);
  }

  let toggle: HTMLButtonElement | null = null;
  if (canSimplify(output)) {
    toggle = el('button', label('render.simpler'), {
      type: 'button',
      class: 'asl-simpler',
      'aria-pressed': String(simpler),
    });
    toggle.addEventListener('click', () => handle.setSimpler(!simpler));
    toolbar.append(toggle);
  }
  if (opts.onBack) {
    const back = el('button', label('render.back'), { type: 'button' });
    back.addEventListener('click', () => opts.onBack?.());
    toolbar.append(back);
  }
  if (toolbar.childElementCount > 0) article.append(toolbar);
  article.append(body);
  container.replaceChildren(article);

  const handle: RenderedOutput = {
    get simpler() {
      return simpler;
    },
    setReading(on) {
      reading = on;
      if (!readButton) return;
      readButton.textContent = label(on ? 'render.stop_reading' : 'render.read_aloud');
      readButton.setAttribute('aria-pressed', String(on));
    },
    setSimpler(on) {
      const next = on && canSimplify(output);
      if (next === simpler) return;
      simpler = next;
      toggle?.setAttribute('aria-pressed', String(simpler));
      // Replace only the body so focus stays on the toggle.
      const fresh = renderBody(output, simpler, opts);
      body.replaceWith(fresh);
      body = fresh;
      announce(simpler && output.simpler !== null ? output.simpler : output.summary);
    },
  };
  return handle;
}
