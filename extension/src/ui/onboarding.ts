// First-run onboarding (docs/conditions.md "Onboarding and language"): language, "read aloud?",
// "do colours look alike?". Shown once, on its own extension page, never on shop pages.
// Every question can be answered by a number key (or Y/N), a tap, a single switch (a Space tap
// steps through the choices, then picks), or by voice: hold Space and say the answer (as on shop
// pages). Answers seed the profile as the user's choices.
import type { Lang } from '@shared/index';
import { setConditionActive } from '../core/composer';
import { markOnboarded, type ProfileStore } from '../core/profile';
import { announce, initAnnouncer } from './announce';
import { createScanner, type ScanItem } from './scanner';
import { label, type UiKey } from './strings';

/** Holding Space at least this long means "talk" (same as on shop pages). */
export const HOLD_MS = 400;

export type StepId = 'language' | 'read_aloud' | 'colour' | 'done';

interface Option {
  id: string;
  label: string;
  /** Language of the label, so screen readers pronounce it correctly. */
  lang: Lang;
  /** Words that select it by voice (lowercase), plus its number. */
  words: string[];
}

const LANGUAGES: Option[] = [
  { id: 'en', label: 'English', lang: 'en', words: ['english', 'angrezi', 'one', '1'] },
  { id: 'hi', label: 'हिंदी', lang: 'hi', words: ['hindi', 'हिंदी', 'हिन्दी', 'two', '2'] },
  { id: 'te', label: 'తెలుగు', lang: 'te', words: ['telugu', 'తెలుగు', 'three', '3'] },
];

export interface OnboardingOptions {
  root: HTMLElement;
  store: ProfileStore;
  /** Called after the last step or Skip (e.g. close the tab). */
  onDone: () => void;
  /** Voice answer: resolves with a transcript, or null if nothing usable was heard. */
  listen?: (opts?: { hold?: boolean }) => Promise<string | null>;
  /** End listening now, keeping what was said (Space released). */
  stopListening?: () => void;
  /** Speak prompts aloud, each line in its own language (the page talks by default). */
  speak?: (lines: { text: string; lang: Lang }[]) => void;
  scanIntervalMs?: number;
}

export interface Onboarding {
  readonly step: StepId;
  choose(index: number): Promise<void>;
  answerText(text: string): Promise<boolean>;
  dispose(): void;
}

export function startOnboarding(opts: OnboardingOptions): Onboarding {
  const { root, store } = opts;
  let step: StepId = 'language';
  let lang: Lang = store.get().prefs.lang;
  initAnnouncer(root);

  const yesNo = (): Option[] => [
    {
      id: 'yes',
      label: label('onboarding.yes', lang),
      lang,
      words: ['yes', 'yeah', 'haan', 'हाँ', 'one', '1', 'y'],
    },
    {
      id: 'no',
      label: label('onboarding.no', lang),
      lang,
      words: ['no', 'nahin', 'नहीं', 'two', '2', 'n'],
    },
  ];
  const options = (): Option[] =>
    step === 'language' ? LANGUAGES : step === 'done' ? [] : yesNo();

  const main = document.createElement('main');
  main.className = 'asl-onboarding';
  root.append(main);

  const scanner = createScanner({
    intervalMs: opts.scanIntervalMs ?? 2500,
    backLabel: '',
    pausedLabel: label('scan.paused', lang),
    onHighlight: (h) => {
      main.querySelectorAll('.asl-option').forEach((b) => b.classList.remove('asl-highlight'));
      if (h?.item)
        main.querySelector(`[data-option="${h.item.id}"]`)?.classList.add('asl-highlight');
    },
    speak: (text) => announce(text),
  });

  function promptText(): string {
    if (step === 'language') {
      return (['en', 'hi', 'te'] as const)
        .map((l) => label('onboarding.choose_language', l))
        .join(' ');
    }
    if (step === 'done') return label('onboarding.done', lang);
    return label(step === 'read_aloud' ? 'onboarding.read_aloud' : 'onboarding.colours', lang);
  }

  function render(): void {
    scanner.stop();
    const heading = document.createElement('h1');
    heading.tabIndex = -1;
    heading.textContent =
      step === 'language' ? label('onboarding.language') : label('onboarding.title', lang);
    const children: HTMLElement[] = [heading];

    if (step === 'language') {
      // What this page is for, then the language question, each in its own language.
      for (const l of ['en', 'hi', 'te'] as const) {
        const p = document.createElement('p');
        p.lang = l;
        p.className = 'asl-purpose';
        p.textContent = label(`onboarding.purpose.${l}` as UiKey);
        children.push(p);
      }
      for (const l of ['en', 'hi', 'te'] as const) {
        const p = document.createElement('p');
        p.lang = l;
        p.className = 'asl-question';
        p.textContent = label('onboarding.choose_language', l);
        children.push(p);
      }
    } else {
      const p = document.createElement('p');
      p.className = 'asl-question';
      p.textContent = promptText();
      children.push(p);
    }

    const opts_ = options();
    if (opts_.length > 0) {
      const group = document.createElement('div');
      group.className = 'asl-options';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', heading.textContent);
      opts_.forEach((o, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'asl-option';
        b.dataset.option = o.id;
        b.lang = o.lang;
        b.textContent = `${i + 1}. ${o.label}`;
        b.addEventListener('click', () => void choose(i));
        group.append(b);
      });
      children.push(group);
      const how = document.createElement('p');
      how.className = 'asl-how';
      how.textContent = label('onboarding.how', lang);
      children.push(how);
    }

    const actions = document.createElement('div');
    actions.className = 'asl-actions';
    if (opts.listen && step !== 'done') {
      const speak = document.createElement('button');
      speak.type = 'button';
      speak.className = 'asl-speak';
      speak.textContent = label('mic.speak', lang);
      speak.addEventListener('click', () => void voice());
      actions.append(speak);
    }
    const end = document.createElement('button');
    end.type = 'button';
    end.className = step === 'done' ? 'asl-primary' : '';
    end.textContent = label(step === 'done' ? 'onboarding.finish' : 'onboarding.skip', lang);
    end.addEventListener('click', () => void finish());
    actions.append(end);
    children.push(actions);

    main.replaceChildren(...children);
    heading.focus();
    announce(promptText());
    opts.speak?.(
      step === 'language'
        ? (['en', 'hi', 'te'] as const).flatMap((l) => [
            { text: label(`onboarding.purpose.${l}` as UiKey), lang: l },
            { text: label('onboarding.choose_language', l), lang: l },
          ])
        : [{ text: promptText(), lang }],
    );
  }

  async function finish(): Promise<void> {
    scanner.stop();
    await markOnboarded();
    opts.onDone();
  }

  async function choose(index: number): Promise<void> {
    const option = options()[index];
    if (!option) return;
    if (step === 'language') {
      lang = option.id as Lang;
      await store.update((d) => {
        d.prefs.lang = lang;
      });
      step = 'read_aloud';
    } else if (step === 'read_aloud') {
      if (option.id === 'yes')
        await store.update((d) => setConditionActive(d, 'visual', true, 'user', 1));
      step = 'colour';
    } else if (step === 'colour') {
      if (option.id === 'yes')
        await store.update((d) => setConditionActive(d, 'colour', true, 'user', 1));
      step = 'done';
      await markOnboarded();
    }
    render();
  }

  async function answerText(text: string): Promise<boolean> {
    const said = text.trim().toLowerCase();
    const index = options().findIndex((o) =>
      o.words.some((w) => said === w || said.split(/\s+/).includes(w)),
    );
    if (index < 0) return false;
    await choose(index);
    return true;
  }

  async function voice(hold = false): Promise<void> {
    const text = await opts.listen?.({ hold }).catch(() => null);
    if (!text || !(await answerText(text)))
      announce(label('onboarding.not_understood', lang), { assertive: true });
  }

  // Keys: numbers (and Y/N) choose. Space: a tap is the single switch (first tap starts stepping
  // through the choices aloud, the next tap picks the highlighted one); holding it is "talk".
  let scanning = false;
  let space: { timer: ReturnType<typeof setTimeout>; held: boolean } | null = null;
  function switchPress(): void {
    const opts_ = options();
    if (opts_.length === 0) return;
    if (!scanning || scanner.level === 'stopped') {
      scanning = true;
      const items: ScanItem[] = opts_.map((o, i) => ({
        id: o.id,
        label: o.label,
        activate: () => {
          scanning = false;
          void choose(i);
        },
      }));
      scanner.start([{ id: step, label: step, items }]);
    } else {
      scanner.press();
    }
  }
  const onKey = (e: KeyboardEvent) => {
    const opts_ = options();
    const n = Number.parseInt(e.key, 10);
    if (n >= 1 && n <= opts_.length) {
      e.preventDefault();
      void choose(n - 1);
    } else if (step !== 'language' && (e.key === 'y' || e.key === 'n')) {
      e.preventDefault();
      void choose(e.key === 'y' ? 0 : 1);
    } else if (e.code === 'Space' && opts_.length > 0) {
      e.preventDefault();
      if (e.repeat || space) return;
      const press = {
        held: false,
        timer: setTimeout(() => {
          if (space !== press || !opts.listen) return;
          press.held = true;
          scanner.stop();
          scanning = false;
          void voice(true);
        }, HOLD_MS),
      };
      space = press;
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code !== 'Space' || !space) return;
    e.preventDefault();
    const press = space;
    space = null;
    clearTimeout(press.timer);
    if (press.held) opts.stopListening?.();
    else switchPress();
  };
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('keydown', onKey);

  render();

  return {
    get step() {
      return step;
    },
    choose,
    answerText,
    dispose() {
      scanner.stop();
      clearTimeout(space?.timer);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('keyup', onKeyUp);
    },
  };
}
