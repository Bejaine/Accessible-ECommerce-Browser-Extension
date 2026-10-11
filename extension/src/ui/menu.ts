// The assistant's menu layout: labelled sections in a fixed order, so the panel reads the same way
// for everyone (and for screen readers, as headings):
//   status (confirmation, suggestion, "Did you mean…", try again, order step) → the answer →
//   Ask (Speak, type a request) → Quick questions → On this page → Reading → Settings.
// Also the typing box (word prediction from phrases, page actions and product names) and the
// turn-status card. Every control stays ≥ 44 px; the look is quiet: hairline separators,
// one accent colour for the main action, no colour-only meaning.
import type { IntentAlternative, TurnResponse } from '@shared/index';
import { label, type UiKey } from './strings';

export const MENU_CSS = `
.asl-controls { display: grid; gap: 0; margin-block-start: 4px; }
.asl-status { display: grid; gap: 10px; }
.asl-status:not(:empty) { padding-block: 10px; }
.asl-group { display: grid; gap: 8px; padding-block: 10px;
  border-block-start: 1px solid var(--asl-line); }
.asl-group[hidden] { display: none; }
/* An answer, the simplified view or the checkout steps is open: keep only the status and Ask. */
.asl-controls.asl-answering > .asl-group:not(.asl-ask) { display: none; }
/* The settings page: only the status area (a confirmation must stay reachable). */
.asl-controls.asl-settings-open > .asl-group { display: none; }
.asl-group > h3 { margin: 0; font-size: 0.875em; font-weight: 700; color: var(--asl-muted); }
.asl-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.asl-grid > button, .asl-list > button, .asl-list > div > button, .asl-row > button,
.asl-group .asl-menu-toggle, .asl-group .asl-settings-toggle {
  box-sizing: border-box; min-block-size: 44px; padding: 8px 12px; margin: 0; font: inherit;
  text-align: start; cursor: pointer; border-radius: 10px; color: var(--asl-fg);
  background: var(--asl-tile); border: 1px solid var(--asl-line-strong); }
.asl-grid > button { inline-size: 100%; }
.asl-grid > .asl-phrases-more { text-align: center; background: transparent; }
/* Starts a new row (even number of phrases before it): use the whole row. */
.asl-grid > .asl-phrases-more:nth-child(odd) { grid-column: 1 / -1; }
.asl-list { display: grid; gap: 8px; }
.asl-list > button, .asl-list > div > button, .asl-group .asl-menu-toggle,
.asl-group .asl-settings-toggle { inline-size: 100%; display: flex; justify-content: space-between;
  align-items: center; gap: 8px; }
.asl-list > [hidden], .asl-list > div > [hidden] { display: none; }
.asl-list > button::after, .asl-list > div > button.asl-menu-toggle::after,
.asl-group .asl-settings-toggle::after {
  content: ''; flex: 0 0 auto; inline-size: 7px; block-size: 7px; margin-inline-end: 4px;
  border-inline-end: 2px solid var(--asl-muted); border-block-end: 2px solid var(--asl-muted);
  transform: rotate(-45deg); }
.asl-list > div > button[aria-expanded='true']::after,
.asl-group .asl-settings-toggle[aria-expanded='true']::after { transform: rotate(45deg); }
.asl-grid > button:hover, .asl-list button:hover, .asl-row > button:hover,
.asl-group .asl-menu-toggle:hover, .asl-group .asl-settings-toggle:hover {
  border-color: var(--asl-fg); }
.asl-row { display: flex; align-items: center; gap: 8px; }
.asl-row > button { flex: 0 0 auto; text-align: center; }
.asl-row > .asl-grow { flex: 1 1 auto; }
.asl-ask .asl-voice { gap: 12px; }
.asl-ask .asl-mic { flex: 1 1 auto; border-radius: 10px; min-block-size: 48px; }
.asl-ask .asl-space-hint { margin: -2px 0 4px; font-size: 0.875em; color: var(--asl-muted); }
.asl-ask .asl-space-hint[hidden] { display: none; }
.asl-type { display: grid; gap: 6px; }
.asl-type label { font-weight: 600; }
.asl-type .asl-hint { font-size: 0.875em; color: var(--asl-muted); }
.asl-type input { box-sizing: border-box; inline-size: 100%; min-block-size: 44px; padding: 8px 12px;
  font: inherit; color: var(--asl-fg); background: var(--asl-bg); border: 1px solid var(--asl-line-strong);
  border-radius: 10px; }
.asl-type input:focus-visible { outline: 3px solid var(--asl-accent); outline-offset: 1px; }
.asl-type .asl-row > button { color: var(--asl-accent-fg); background: var(--asl-accent);
  border-color: var(--asl-accent); font-weight: 700; }
.asl-speed { justify-content: space-between; }
.asl-speed .asl-speed-value { flex: 1 1 auto; text-align: center; font-weight: 600; }
.asl-card { display: grid; gap: 8px; padding: 12px; border: 2px solid var(--asl-fg); border-radius: 12px; }
.asl-card[hidden] { display: none; }
.asl-card h3 { margin: 0; font-size: 1em; }
.asl-card p { margin: 0; }
.asl-card .asl-grid > button { font-weight: 700; min-block-size: 56px; text-align: center; }
.asl-progress { margin: 0; padding: 8px 12px; border-inline-start: 4px solid var(--asl-accent);
  background: var(--asl-tile); border-radius: 0 8px 8px 0; font-weight: 600; }
.asl-progress[hidden] { display: none; }
.asl-retry { justify-self: start; min-block-size: 44px; padding: 8px 16px; font: inherit; font-weight: 700;
  cursor: pointer; border-radius: 10px; color: var(--asl-accent-fg); background: var(--asl-accent);
  border: 2px solid var(--asl-border); }
.asl-retry[hidden] { display: none; }
@media (max-width: 360px) { .asl-grid { grid-template-columns: minmax(0, 1fr); } }
@media (prefers-contrast: more) {
  .asl-group { border-block-start-width: 2px; }
  .asl-grid > button, .asl-list button, .asl-row > button, .asl-type input,
  .asl-group .asl-menu-toggle, .asl-group .asl-settings-toggle { border: 2px solid var(--asl-fg); }
}
@media (forced-colors: active) {
  .asl-group { border-color: CanvasText; }
  .asl-grid > button, .asl-list button, .asl-row > button, .asl-retry,
  .asl-group .asl-menu-toggle, .asl-group .asl-settings-toggle {
    background: ButtonFace; color: ButtonText; border-color: ButtonText; }
  .asl-type input { border-color: CanvasText; }
  .asl-type .asl-row > button { background: ButtonFace; color: ButtonText; border-color: ButtonText; }
  .asl-progress { border-color: Highlight; }
}
`;

let ids = 0;

export interface MenuSection {
  readonly element: HTMLElement;
  /** Hidden when it has nothing to offer on this page. */
  setHidden(hidden: boolean): void;
}

/** A labelled group (h3 + content) of the menu. */
export function createMenuSection(
  title: UiKey,
  children: HTMLElement[],
  className = '',
  lang?: string,
): MenuSection {
  const section = document.createElement('section');
  section.className = `asl-group ${className}`.trim();
  const id = `asl-group-${++ids}`;
  section.setAttribute('aria-labelledby', id);
  const h = document.createElement('h3');
  h.id = id;
  h.textContent = label(title, lang);
  section.append(h, ...children);
  return {
    element: section,
    setHidden(hidden) {
      section.hidden = hidden;
    },
  };
}

/** Most suggestions offered by the typing box. */
export const MAX_SUGGESTIONS = 8;

export interface TypeBox {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  /** What the typing box predicts from (phrases, page actions, product names). */
  setSuggestions(words: string[]): void;
}

/**
 * Type a request (speech users, or anyone who prefers typing): Enter or Send hands the text to
 * the same path as speech (local matcher first, then a turn). Prediction is the browser's own
 * datalist, so it works with screen readers and on phones without extra widgets.
 */
export function createTypeBox(onSubmit: (text: string) => void, lang?: string): TypeBox {
  const n = ++ids;
  const form = document.createElement('form');
  form.className = 'asl-type';
  const inputId = `asl-type-${n}`;
  const hintId = `asl-type-hint-${n}`;
  const listId = `asl-type-list-${n}`;
  const name = document.createElement('label');
  name.htmlFor = inputId;
  name.textContent = label('type.label', lang);
  const input = document.createElement('input');
  input.id = inputId;
  input.type = 'text';
  input.autocomplete = 'off';
  input.setAttribute('list', listId);
  input.setAttribute('aria-describedby', hintId);
  input.className = 'asl-grow';
  const list = document.createElement('datalist');
  list.id = listId;
  const send = document.createElement('button');
  send.type = 'submit';
  send.textContent = label('type.send', lang);
  const row = document.createElement('div');
  row.className = 'asl-row';
  row.append(input, send);
  const hint = document.createElement('span');
  hint.id = hintId;
  hint.className = 'asl-hint';
  hint.textContent = label('type.hint', lang);
  form.append(name, row, hint, list);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    input.value = '';
    onSubmit(text);
  });
  return {
    element: form,
    input,
    setSuggestions(words) {
      const unique = [...new Set(words.map((w) => w.trim()).filter(Boolean))];
      list.replaceChildren(
        ...unique.slice(0, 40).map((w) => {
          const option = document.createElement('option');
          option.value = w;
          return option;
        }),
      );
    },
  };
}

export interface TurnStatusState {
  alternatives: readonly IntentAlternative[];
  canRetry: boolean;
  workflow: TurnResponse['workflow'];
}

export interface TurnStatus {
  readonly element: HTMLElement;
  /** What is new and worth announcing: the options' question and/or the task's step. */
  render(state: TurnStatusState): { question: string | null; step: string | null };
  /** The two option buttons (for switch scanning), empty when not asking. */
  readonly optionButtons: HTMLButtonElement[];
}

/** "Did you mean X or Y?" as two big buttons, "Try again", and the order task's step. */
export function createTurnStatus(
  opts: { onChoose: (index: number) => void; onRetry: () => void },
  lang?: string,
): TurnStatus {
  const wrap = document.createElement('div');
  wrap.className = 'asl-turn-status';
  wrap.style.display = 'contents';

  const progress = document.createElement('p');
  progress.className = 'asl-progress';
  progress.hidden = true;

  const card = document.createElement('section');
  card.className = 'asl-card';
  card.hidden = true;
  const cardId = `asl-alt-${++ids}`;
  card.setAttribute('aria-labelledby', cardId);
  const heading = document.createElement('h3');
  heading.id = cardId;
  heading.textContent = label('alt.title', lang);
  const options = document.createElement('div');
  options.className = 'asl-grid';
  card.append(heading, options);

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'asl-retry';
  retry.textContent = label('retry.button', lang);
  retry.hidden = true;
  retry.addEventListener('click', () => opts.onRetry());

  wrap.append(progress, card, retry);

  let lastAlternatives = '';
  let lastStep = '';
  let buttons: HTMLButtonElement[] = [];

  return {
    element: wrap,
    get optionButtons() {
      return buttons;
    },
    render(state) {
      let question: string | null = null;
      let stepSaid: string | null = null;

      const labels = state.alternatives.slice(0, 2).map((a) => a.label);
      const altKey = labels.join('\n');
      if (altKey !== lastAlternatives) {
        lastAlternatives = altKey;
        buttons = labels.map((text, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = text;
          b.addEventListener('click', () => opts.onChoose(i));
          return b;
        });
        options.replaceChildren(...buttons);
        card.hidden = buttons.length === 0;
        if (labels.length === 2) {
          question = label('alt.prompt', lang)
            .replace('{a}', labels[0]!)
            .replace('{b}', labels[1]!);
        }
      }

      const wf = state.workflow;
      const step = wf
        ? label('task.step', lang)
            .replace('{task}', label(`task.${wf.name}` as UiKey, lang))
            .replace('{step}', String(wf.step))
            .replace('{total}', String(wf.total_steps))
        : '';
      if (step !== lastStep) {
        lastStep = step;
        progress.textContent = step;
        progress.hidden = !step;
        if (step) stepSaid = step;
      }

      retry.hidden = !state.canRetry;
      return { question, step: stepSaid };
    },
  };
}
