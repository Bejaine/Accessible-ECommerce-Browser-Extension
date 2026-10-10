// Suggest-then-switch (rule 5, docs/conditions.md "Suggestion flow"). Logic only; the card UI
// and key handling live in the app.
//
// - A condition is suggested when its score is ready (≥ 0.7 with enough independent groups),
//   it isn't already on, and the user hasn't declined it this session. Colour is never inferred.
// - One suggestion at a time, at least 60 s apart.
// - Announced 10 s countdown; the user can accept now, cancel (no / Escape / tap / switch), or let
//   it finish. Once applied, one action undoes it. Declined or undone modes are never re-offered
//   this session.
// - Ambiguity: keyboard use alone fits visual and motor, so instead of guessing ask one question.
import { label, type UiKey } from '../ui/strings';
import { INFERRED_CONDITIONS, type InferredCondition, type ScoreEngine } from './scores';

export type SuggestionState =
  | { kind: 'idle' }
  | { kind: 'countdown'; condition: InferredCondition; secondsLeft: number }
  | { kind: 'applied'; condition: InferredCondition }
  | { kind: 'question' };

export type QuestionAnswer = 'visual' | 'motor' | 'neither';

export interface SuggesterOptions {
  engine: ScoreEngine;
  isActive: (c: InferredCondition) => boolean;
  apply: (c: InferredCondition, score: number) => void;
  revert: (c: InferredCondition) => void;
  announce: (text: string, assertive?: boolean) => void;
  now?: () => number;
  lang?: string;
  countdownSeconds?: number;
  minGapMs?: number;
}

export interface Suggester {
  readonly state: SuggestionState;
  /** Called on every state change (card, badge); returns an unsubscribe function. */
  subscribe(listener: (state: SuggestionState) => void): () => void;
  /** Look at the scores; may start a suggestion or the ambiguity question. */
  check(): void;
  accept(): void;
  decline(): void;
  undo(): void;
  answer(choice: QuestionAnswer): void;
  dispose(): void;
}

/** Keyboard-only evidence strong enough to ask the visual-or-motor question. */
export const KEYBOARD_QUESTION_AT = 0.3;

export const modeName = (c: InferredCondition, lang?: string) => label(`mode.${c}` as UiKey, lang);

const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));

export function createSuggester(opts: SuggesterOptions): Suggester {
  const now = opts.now ?? (() => performance.now());
  const lang = opts.lang;
  const countdownSeconds = opts.countdownSeconds ?? 10;
  const minGapMs = opts.minGapMs ?? 60_000;
  const declined = new Set<InferredCondition>();
  let questionAsked = false;
  let lastOfferAt = -Infinity;
  let state: SuggestionState = { kind: 'idle' };
  const listeners = new Set<(state: SuggestionState) => void>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const t = (key: UiKey, vars: Record<string, string | number> = {}) =>
    fill(label(key, lang), vars);

  function set(next: SuggestionState): void {
    state = next;
    listeners.forEach((l) => l(state));
  }

  function stopTimer(): void {
    clearInterval(timer);
    timer = undefined;
  }

  function applyNow(condition: InferredCondition): void {
    stopTimer();
    opts.apply(condition, opts.engine.scores()[condition].score);
    set({ kind: 'applied', condition });
    opts.announce(t('suggest.on', { mode: modeName(condition, lang) }));
  }

  function startCountdown(condition: InferredCondition): void {
    lastOfferAt = now();
    set({ kind: 'countdown', condition, secondsLeft: countdownSeconds });
    opts.announce(
      t('suggest.offer', { mode: modeName(condition, lang), seconds: countdownSeconds }),
      true,
    );
    timer = setInterval(() => {
      if (state.kind !== 'countdown') return stopTimer();
      const secondsLeft = state.secondsLeft - 1;
      if (secondsLeft <= 0) return applyNow(condition);
      set({ kind: 'countdown', condition, secondsLeft });
      if (secondsLeft === 5) opts.announce(t('suggest.seconds', { seconds: secondsLeft }));
    }, 1000);
  }

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check() {
      if (state.kind === 'countdown' || state.kind === 'question') return;
      if (now() - lastOfferAt < minGapMs) return;
      const scores = opts.engine.scores();
      const candidate = INFERRED_CONDITIONS.filter(
        (c) => scores[c].ready && !opts.isActive(c) && !declined.has(c),
      ).sort((a, b) => scores[b].score - scores[a].score)[0];
      if (candidate) {
        startCountdown(candidate);
        return;
      }
      const keyboard = scores.visual.groups.keyboard ?? 0;
      const open = (c: InferredCondition) => !opts.isActive(c) && !declined.has(c);
      if (!questionAsked && keyboard >= KEYBOARD_QUESTION_AT && open('visual') && open('motor')) {
        questionAsked = true;
        lastOfferAt = now();
        set({ kind: 'question' });
        // A question waits for an answer: no countdown, no time limit.
        opts.announce(t('suggest.question'), true);
      }
    },
    accept() {
      if (state.kind === 'countdown') applyNow(state.condition);
    },
    decline() {
      if (state.kind === 'countdown') declined.add(state.condition);
      if (state.kind === 'countdown' || state.kind === 'question') {
        stopTimer();
        set({ kind: 'idle' });
        opts.announce(t('suggest.cancelled'));
      } else if (state.kind === 'applied') {
        set({ kind: 'idle' });
      }
    },
    undo() {
      if (state.kind !== 'applied') return;
      const { condition } = state;
      opts.revert(condition);
      declined.add(condition);
      set({ kind: 'idle' });
      opts.announce(t('suggest.undone', { mode: modeName(condition, lang) }));
    },
    answer(choice) {
      if (state.kind !== 'question') return;
      if (choice === 'neither') {
        declined.add('visual');
        declined.add('motor');
        set({ kind: 'idle' });
        opts.announce(t('suggest.cancelled'));
        return;
      }
      // The user chose it: that is acceptance, so apply now (still undoable).
      applyNow(choice);
    },
    dispose() {
      stopTimer();
    },
  };
}
