// The assistant's voice for the app, on top of Track A's player (rule 12: all audio goes through
// src/audio/player.ts). This adapter keeps the small interface the app and UI use, and adds what
// the app needs on top of the player:
// - prompt(): speak a short message over an answer without losing it (snapshot / restore): a
//   playing answer carries on afterwards; a paused one resumes from the same sentence on Resume
// - sayLines(): several lines in different languages, one after another (setup page)
// - setRate(): follow prefs.tts_rate by stepping the player (its speeds are 0.25 apart)
// - onChange(): playing / paused / idle and the current sentence, for the playback bar
import type { AccessibleOutput, Lang } from '@shared/index';
import type { Player, PlayerEvent, PlayerSnapshot } from '../audio/player';

export type PlaybackState = 'idle' | 'playing' | 'paused';

export interface Speaker {
  speakOutput(output: AccessibleOutput, opts?: { verbosity?: 'short' | 'normal' }): void;
  say(text: string, lang: Lang): void;
  sayLines(lines: { text: string; lang: Lang }[]): void;
  prompt(text: string, lang: Lang): void;
  pause(): void;
  resume(): void;
  repeatSentence(): void;
  repeatAll(): void;
  back(): void;
  nextSection(): void;
  previousSection(): void;
  stop(): void;
  setRate(rate: number): void;
  readonly state: PlaybackState;
  readonly speaking: boolean;
  readonly sentence: string | null;
  onChange(
    listener: (speaking: boolean, state: PlaybackState, sentence: string | null) => void,
  ): () => void;
}

export function createPlayerSpeaker(
  player: Player,
  opts: {
    /** Called once per language that has no voice on this device (player 'text-only'). */
    onNoVoice?: (lang: Lang) => void;
  } = {},
): Speaker {
  const listeners = new Set<
    (speaking: boolean, state: PlaybackState, sentence: string | null) => void
  >();
  let sentence: string | null = null;
  let lang: Lang = 'en';
  /** An answer interrupted by a prompt, and whether it was playing. */
  let interrupted: { snap: PlayerSnapshot; playing: boolean } | null = null;
  let inPrompt = false;
  /** Remaining lines for sayLines(). */
  let lines: { text: string; lang: Lang }[] = [];
  const noVoice = new Set<Lang>();
  const emit = () =>
    listeners.forEach((l) => l(player.state === 'playing', player.state, sentence));

  function playOne(text: string, l: Lang): void {
    lang = l;
    player.play([{ segments: [{ text }] }], l);
  }

  player.subscribe((event: PlayerEvent) => {
    if (event.type === 'sentence') {
      sentence = event.text;
      emit();
    } else if (event.type === 'state') {
      if (event.state === 'idle' && !inPrompt && lines.length === 0) sentence = null;
      emit();
    } else if (event.type === 'text-only' && !noVoice.has(lang)) {
      noVoice.add(lang);
      opts.onNoVoice?.(lang);
    } else if (event.type === 'end') {
      if (lines.length > 0) {
        const next = lines.shift()!;
        playOne(next.text, next.lang);
      } else if (inPrompt) {
        inPrompt = false;
        // A playing answer carries on where it was; a paused one waits for Resume.
        if (interrupted?.playing) {
          const { snap } = interrupted;
          interrupted = null;
          player.restore(snap);
        } else {
          emit();
        }
      }
    }
  });

  /** New content replaces whatever was playing (and any interrupted answer). */
  function fresh(): void {
    interrupted = null;
    inPrompt = false;
    lines = [];
  }

  const speaker: Speaker = {
    speakOutput(output, o = {}) {
      fresh();
      lang = output.lang;
      if (o.verbosity === 'short') {
        player.play(
          [{ segments: [output.summary, ...output.warnings].map((text) => ({ text })) }],
          output.lang,
        );
      } else {
        player.playOutput(output);
      }
    },
    say(text, l) {
      fresh();
      playOne(text, l);
    },
    sayLines(all) {
      fresh();
      const [first, ...rest] = all;
      if (!first) return;
      lines = rest;
      playOne(first.text, first.lang);
    },
    prompt(text, l) {
      const snap = player.snapshot();
      if (snap && !inPrompt && player.state !== 'idle') {
        interrupted = { snap, playing: player.state === 'playing' };
      }
      inPrompt = true;
      lines = [];
      playOne(text, l);
    },
    pause() {
      player.pause();
    },
    resume() {
      if (interrupted && player.state !== 'paused') {
        const { snap } = interrupted;
        interrupted = null;
        player.restore(snap);
        return;
      }
      player.resume();
    },
    repeatSentence() {
      player.repeatSentence();
    },
    repeatAll() {
      player.repeatAll();
    },
    back() {
      player.back();
    },
    nextSection() {
      player.nextSection();
    },
    previousSection() {
      player.previousSection();
    },
    stop() {
      fresh();
      player.stop();
      sentence = null;
      emit();
    },
    setRate(rate) {
      // The player moves in fixed steps; step it until it matches (or can't move further).
      for (let i = 0; i < 12 && player.rate < rate - 1e-6; i++) {
        const before = player.rate;
        player.faster();
        if (player.rate === before) break;
      }
      for (let i = 0; i < 12 && player.rate > rate + 1e-6; i++) {
        const before = player.rate;
        player.slower();
        if (player.rate === before) break;
      }
    },
    get state() {
      // A paused answer behind a finished prompt still counts as paused (Resume brings it back).
      return player.state === 'idle' && interrupted ? 'paused' : player.state;
    },
    get speaking() {
      return player.state === 'playing';
    },
    get sentence() {
      return sentence;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return speaker;
}
