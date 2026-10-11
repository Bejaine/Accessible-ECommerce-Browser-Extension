// Settings in the overlay. Everything the assistant inferred or set is visible and adjustable:
// each mode shows whether the user turned it on or it was turned on automatically (rule 5:
// always undoable), plus what is in effect right now and the values behind it (assistant voice,
// speech speed lives in its own control, text size, short answers, switch key, language).
// Native controls with visible labels, behind a "Settings" disclosure button.
import type { Lang, Profile, ResolvedMode } from '@shared/index';
import { setConditionActive } from '../core/composer';
import type { ProfileStore } from '../core/profile';
import { announce } from './announce';
import { DEFAULT_DWELL_MS, DWELL_TIMES_MS } from './dwell';
import { formatRate } from './speechSpeed';
import { label, type UiKey } from './strings';

export const SETTINGS_CSS = `
.asl-settings-toggle { min-block-size: 44px; padding: 8px 16px; font: inherit; cursor: pointer;
  border-radius: 8px; color: var(--asl-fg); background: var(--asl-bg); border: 2px solid var(--asl-fg); }
.asl-settings { display: grid; gap: 16px; padding-block: 8px 4px; }
.asl-settings[hidden] { display: none; }
.asl-settings > p { margin: 0; color: var(--asl-muted); font-size: 0.9375em; }
.asl-settings fieldset { border: 0; padding: 0; margin: 0; display: grid; gap: 4px; min-inline-size: 0; }
.asl-settings legend { padding: 0; font-weight: 700; margin-block-end: 4px; }
.asl-settings .asl-check { display: grid; grid-template-columns: 24px minmax(0, 1fr); column-gap: 12px;
  align-items: center; min-block-size: 44px; cursor: pointer; }
.asl-settings .asl-check .asl-hint { grid-column: 2; }
.asl-settings .asl-check .asl-hint:empty { display: none; }
.asl-settings .asl-field { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  min-block-size: 44px; }
.asl-settings input[type='checkbox'] { inline-size: 22px; block-size: 22px; margin: 0; }
.asl-settings select { min-block-size: 44px; font: inherit; color: var(--asl-fg); background: var(--asl-bg);
  border: 1px solid var(--asl-line-strong, var(--asl-fg)); border-radius: 10px; padding: 4px 8px; }
.asl-settings .asl-hint { font-size: 0.875em; color: var(--asl-muted); }
.asl-settings .asl-row > span { flex: 1 1 auto; text-align: center; font-weight: 600; }
.asl-settings .asl-field > span { flex: 1 1 auto; }
.asl-settings .asl-row > button, .asl-settings .asl-field > button, .asl-settings .asl-wide-button {
  min-block-size: 44px; padding: 8px 12px; font: inherit; cursor: pointer; border-radius: 10px;
  color: var(--asl-fg); background: var(--asl-tile, var(--asl-bg));
  border: 1px solid var(--asl-line-strong, var(--asl-fg)); }
.asl-settings .asl-wide-button { inline-size: 100%; text-align: start; }
@media (prefers-contrast: more) {
  .asl-settings .asl-row > button, .asl-settings .asl-field > button, .asl-settings .asl-wide-button,
  .asl-settings select { border: 2px solid var(--asl-fg); }
}
@media (forced-colors: active) {
  .asl-settings .asl-row > button, .asl-settings .asl-field > button, .asl-settings .asl-wide-button {
    background: ButtonFace; color: ButtonText; border-color: ButtonText; }
}
`;

/** A titled group of settings. */
function group(legendKey: UiKey, ...children: HTMLElement[]): HTMLFieldSetElement {
  const fieldset = document.createElement('fieldset');
  const legend = document.createElement('legend');
  legend.textContent = label(legendKey);
  fieldset.append(legend, ...children);
  return fieldset;
}

const MODES: { condition: keyof Profile['conditions']; key: UiKey }[] = [
  { condition: 'visual', key: 'mode.visual' },
  { condition: 'motor', key: 'mode.motor' },
  { condition: 'speech', key: 'mode.speech' },
  { condition: 'ageing', key: 'mode.ageing' },
  { condition: 'colour', key: 'settings.colour' },
];

const LANGUAGES: { id: Lang; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'hi', name: 'हिंदी' },
  { id: 'te', name: 'తెలుగు' },
];

export const TEXT_STEP = 0.25;

export interface SettingsOptions {
  store: ProfileStore;
  onStartScanning: () => void;
  onRunSetup: () => void;
  /** The assistant's own voice (device preference). */
  voice: { get(): boolean; set(on: boolean): void };
  /** Dwell to click (device preference); null = off. */
  dwell: { get(): number | null; set(ms: number | null): void };
}

export interface Settings {
  readonly element: HTMLElement;
  render(profile: Profile, mode: ResolvedMode): void;
}

let ids = 0;

const keyName = (code: string) => code.replace(/^(Key|Digit)/, '');

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function checkbox(text: string, onChange: (checked: boolean) => void) {
  const row = document.createElement('label');
  row.className = 'asl-check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.addEventListener('change', () => onChange(box.checked));
  const name = document.createElement('span');
  name.textContent = text;
  const hint = document.createElement('span');
  hint.className = 'asl-hint';
  row.append(box, name, hint);
  return { row, box, hint };
}

export function createSettings(opts: SettingsOptions): Settings {
  const { store } = opts;
  const wrap = document.createElement('div');
  const panelId = `asl-settings-${++ids}`;
  const saved = (key: UiKey, on: boolean) =>
    announce(
      label('settings.saved')
        .replace('{setting}', label(key))
        .replace('{state}', label(on ? 'settings.on' : 'settings.off')),
    );

  const toggle = button(label('settings.title'), () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });
  toggle.className = 'asl-settings-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', panelId);

  const panel = document.createElement('section');
  panel.id = panelId;
  panel.className = 'asl-settings';
  panel.setAttribute('aria-label', label('settings.title'));
  panel.hidden = true;

  // What is in effect right now (inferred or chosen), in words.
  const current = document.createElement('p');

  // Modes, each with where it came from.
  const modes = document.createElement('fieldset');
  const legend = document.createElement('legend');
  legend.textContent = label('settings.modes');
  modes.append(legend);
  const modeRows = new Map<string, ReturnType<typeof checkbox>>();
  for (const { condition, key } of MODES) {
    const row = checkbox(label(key), async (checked) => {
      await store.update((d) => setConditionActive(d, condition, checked, 'user', checked ? 1 : 0));
      saved(key, checked);
    });
    modeRows.set(condition, row);
    modes.append(row.row);
  }

  // Assistant voice (device preference) and short answers.
  const voice = checkbox(label('settings.voice'), (checked) => {
    opts.voice.set(checked);
    saved('settings.voice', checked);
  });
  voice.hint.textContent = label('settings.voice_hint');
  const short = checkbox(label('settings.short'), async (checked) => {
    await store.update((d) => {
      d.prefs.verbosity = checked ? 'short' : 'normal';
    });
    saved('settings.short', checked);
  });

  // Dwell to click, and how long to rest.
  const dwell = checkbox(label('settings.dwell'), (checked) => {
    opts.dwell.set(checked ? Number(dwellSelect.value) || DEFAULT_DWELL_MS : null);
    dwellRow.hidden = !checked;
    saved('settings.dwell', checked);
  });
  dwell.hint.textContent = label('settings.dwell_hint');
  const dwellRow = document.createElement('label');
  dwellRow.className = 'asl-field';
  const dwellName = document.createElement('span');
  dwellName.textContent = label('settings.dwell_time');
  const dwellSelect = document.createElement('select');
  for (const ms of DWELL_TIMES_MS) {
    const option = document.createElement('option');
    option.value = String(ms);
    option.textContent = label('settings.seconds').replace('{seconds}', String(ms / 1000));
    dwellSelect.append(option);
  }
  dwellSelect.value = String(DEFAULT_DWELL_MS);
  dwellSelect.addEventListener('change', () => opts.dwell.set(Number(dwellSelect.value)));
  dwellRow.append(dwellName, dwellSelect);

  // Text size.
  const textRow = document.createElement('div');
  textRow.className = 'asl-row';
  textRow.setAttribute('role', 'group');
  textRow.setAttribute('aria-label', label('settings.text_size'));
  const textValue = document.createElement('span');
  const stepText = (direction: 1 | -1) =>
    void store.update((d) => {
      d.prefs.text_scale = Math.min(3, Math.max(1, d.prefs.text_scale + direction * TEXT_STEP));
    });
  textRow.append(
    button(label('settings.smaller'), () => stepText(-1)),
    textValue,
    button(label('settings.larger'), () => stepText(1)),
  );

  // Language.
  const langRow = document.createElement('label');
  langRow.className = 'asl-field';
  const langName = document.createElement('span');
  langName.textContent = label('settings.language');
  const select = document.createElement('select');
  for (const l of LANGUAGES) {
    const option = document.createElement('option');
    option.value = l.id;
    option.lang = l.id;
    option.textContent = l.name;
    select.append(option);
  }
  select.addEventListener('change', () => {
    void store.update((d) => {
      d.prefs.lang = select.value as Lang;
    });
  });
  langRow.append(langName, select);

  // Switch key: press "Change switch key", then the key to use. Escape keeps the old one.
  const switchLabel = document.createElement('span');
  const changeSwitch = button(label('settings.set_switch'), () => {
    announce(label('settings.press_key'), { assertive: true });
    const capture = (e: KeyboardEvent) => {
      if (e.key === 'Tab') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      document.removeEventListener('keydown', capture, true);
      if (e.key === 'Escape') return;
      void store.update((d) => {
        d.prefs.switch_key = e.code;
      });
      announce(label('settings.switch_key').replace('{key}', keyName(e.code)));
    };
    document.addEventListener('keydown', capture, true);
  });
  const switchRow = document.createElement('div');
  switchRow.className = 'asl-field';
  switchRow.append(switchLabel, changeSwitch);

  const scan = button(label('settings.scan'), opts.onStartScanning);
  scan.className = 'asl-wide-button';
  const setup = button(label('settings.setup'), opts.onRunSetup);
  setup.className = 'asl-wide-button';

  const textName = document.createElement('span');
  textName.className = 'asl-hint';
  textName.textContent = label('settings.text_size');
  panel.append(
    current,
    modes,
    group('settings.group_reading', voice.row, short.row),
    group('settings.group_display', textName, textRow, langRow),
    group('settings.group_pointer', dwell.row, dwellRow),
    group('settings.group_switch', switchRow, scan),
    setup,
  );
  wrap.append(toggle, panel);

  return {
    element: wrap,
    render(profile, mode) {
      current.textContent = label('settings.current')
        .replace('{options}', String(mode.max_options))
        .replace('{rate}', formatRate(mode.tts_rate))
        .replace('{scan}', String(mode.scan_interval_ms / 1000));
      for (const [condition, row] of modeRows) {
        const state = profile.conditions[condition as keyof Profile['conditions']];
        row.box.checked = state.active;
        row.hint.textContent = state.active
          ? label(state.source === 'user' ? 'settings.by_you' : 'settings.by_suggestion')
          : '';
      }
      voice.box.checked = opts.voice.get();
      const dwellMs = opts.dwell.get();
      dwell.box.checked = dwellMs !== null;
      dwellRow.hidden = dwellMs === null;
      if (dwellMs !== null) dwellSelect.value = String(dwellMs);
      short.box.checked = profile.prefs.verbosity === 'short';
      textValue.textContent = `${Math.round(profile.prefs.text_scale * 100)}%`;
      select.value = profile.prefs.lang;
      switchLabel.textContent = label('settings.switch_key').replace(
        '{key}',
        keyName(profile.prefs.switch_key),
      );
    },
  };
}
