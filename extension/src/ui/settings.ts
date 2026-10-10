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
.asl-settings { display: grid; gap: 12px; padding: 12px; border: 2px solid var(--asl-fg); border-radius: 12px; }
.asl-settings[hidden] { display: none; }
.asl-settings fieldset { border: 0; padding: 0; margin: 0; display: grid; gap: 4px; }
.asl-settings legend { font-weight: 700; margin-block-end: 4px; }
.asl-settings label { display: flex; align-items: center; gap: 12px; min-block-size: 44px; cursor: pointer;
  flex-wrap: wrap; }
.asl-settings input[type='checkbox'] { inline-size: 24px; block-size: 24px; }
.asl-settings select { min-block-size: 44px; font: inherit; }
.asl-settings .asl-hint { font-size: 0.9em; color: var(--asl-muted); }
.asl-settings .asl-chips button { min-block-size: 44px; }
`;

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
  textRow.className = 'asl-chips';
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
  switchRow.className = 'asl-chips';
  switchRow.append(switchLabel, changeSwitch);

  const actions = document.createElement('div');
  actions.className = 'asl-chips';
  actions.append(
    button(label('settings.scan'), opts.onStartScanning),
    button(label('settings.setup'), opts.onRunSetup),
  );

  panel.append(
    current,
    modes,
    voice.row,
    short.row,
    dwell.row,
    dwellRow,
    textRow,
    langRow,
    switchRow,
    actions,
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
