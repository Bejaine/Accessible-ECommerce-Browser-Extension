// A small note in the corner (above the assistant button) saying which accessibility features are
// on, so nothing the assistant adjusted is hidden from the user (rule 5: visible and undoable).
// It names features, never people or conditions ("Read-aloud mode", not a diagnosis), says when
// one was turned on automatically, and offers "Change" (Settings) and "Hide". Hidden while the
// panel is open, when nothing is on, or after "Hide" until the set of features changes.
// Not a live region: turning a feature on is already announced by the suggestion flow.
import type { Profile } from '@shared/index';
import { label, type UiKey } from './strings';

export const ACTIVE_FEATURES_CSS = `
.asl-active { position: fixed; inset-block-end: 72px; inset-inline-end: 16px; z-index: 2147483646;
  box-sizing: border-box; max-inline-size: min(300px, calc(100vw - 32px)); padding: 10px 12px;
  display: grid; gap: 6px; font-size: 0.875em; color: var(--asl-fg); background: var(--asl-bg);
  border: 1px solid var(--asl-line-strong, var(--asl-fg)); border-radius: 12px;
  box-shadow: 0 2px 12px rgb(0 0 0 / 0.2); }
.asl-active[hidden], .asl-panel:not([hidden]) ~ .asl-active { display: none; }
.asl-active p { margin: 0; font-weight: 700; }
.asl-active ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 2px; }
.asl-active li::before { content: '✓'; margin-inline-end: 6px; }
.asl-active .asl-hint { color: var(--asl-muted); }
.asl-active .asl-row { display: flex; gap: 8px; }
.asl-active button { min-block-size: 44px; min-inline-size: 44px; padding: 6px 12px; font: inherit;
  cursor: pointer; border-radius: 10px; color: var(--asl-fg); background: var(--asl-tile, var(--asl-bg));
  border: 1px solid var(--asl-line-strong, var(--asl-fg)); }
@media (max-width: 480px) { .asl-active { inset-inline: 8px; max-inline-size: none; } }
@media (forced-colors: active) { .asl-active { border-color: CanvasText; } }
`;

/** Features in a fixed order, by their respectful names (the same ones Settings uses). */
export const FEATURES: { condition: keyof Profile['conditions']; key: UiKey }[] = [
  { condition: 'visual', key: 'mode.visual' },
  { condition: 'motor', key: 'mode.motor' },
  { condition: 'speech', key: 'mode.speech' },
  { condition: 'ageing', key: 'mode.ageing' },
  { condition: 'colour', key: 'settings.colour' },
];

const HIDDEN_KEY = 'asl-active-hidden';

export interface ActiveFeatures {
  readonly element: HTMLElement;
  render(profile: Profile): void;
}

export function createActiveFeatures(
  opts: { onChange: () => void },
  lang?: string,
): ActiveFeatures {
  const note = document.createElement('aside');
  note.className = 'asl-active';
  note.setAttribute('aria-label', label('active.title', lang));
  note.hidden = true;
  const title = document.createElement('p');
  title.textContent = label('active.title', lang);
  const list = document.createElement('ul');
  const row = document.createElement('div');
  row.className = 'asl-row';
  const change = document.createElement('button');
  change.type = 'button';
  change.textContent = label('active.change', lang);
  change.addEventListener('click', () => opts.onChange());
  const hide = document.createElement('button');
  hide.type = 'button';
  hide.textContent = label('active.hide', lang);
  hide.setAttribute('aria-label', label('active.hide_name', lang));
  row.append(change, hide);
  note.append(title, list, row);

  let signature = '';
  const hiddenFor = (): string | null => {
    try {
      return sessionStorage.getItem(HIDDEN_KEY);
    } catch {
      return null;
    }
  };
  hide.addEventListener('click', () => {
    try {
      sessionStorage.setItem(HIDDEN_KEY, signature);
    } catch {
      // private mode: hide for this page only
    }
    note.hidden = true;
  });

  return {
    element: note,
    render(profile) {
      const on = FEATURES.filter((f) => profile.conditions[f.condition].active);
      signature = on
        .map((f) => `${f.condition}:${profile.conditions[f.condition].source}`)
        .join(',');
      list.replaceChildren(
        ...on.map((f) => {
          const li = document.createElement('li');
          li.textContent = label(f.key, lang);
          if (profile.conditions[f.condition].source === 'inferred') {
            const auto = document.createElement('span');
            auto.className = 'asl-hint';
            auto.textContent = ` (${label('active.auto', lang)})`;
            li.append(auto);
          }
          return li;
        }),
      );
      note.hidden = on.length === 0 || hiddenFor() === signature;
    },
  };
}
