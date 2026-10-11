// The assistant's voice for the app, on top of Track A's player (rule 12: all audio goes through
// src/audio/player.ts). This adapter keeps the small interface the app and UI use, and adds what
// the app needs on top of the player:
// - prompt(): speak a short message over an answer without losing it (snapshot / restore): a
//   playing answer carries on afterwards; a paused one resumes from the same sentence on Resume
// - sayLines(): several lines in different languages, one after another (setup page)
// - setRate(): follow prefs.tts_rate by stepping the player (its speeds are 0.25 apart)
// - onChange(): playing / paused / idle and the current sentence, for the playback bar
// - snapshot() / offerResume(): where the answer is (never a prompt), and after a page change
//   that position as a paused answer, so Resume (word, key or bar) carries on from there
import type { AccessibleOutput, Lang } from '@shared/index';
import type { Player, PlayerEvent, PlayerSnapshot } from '../audio/player';

export type PlaybackState = 'idle' | 'playing' | 'paused';

export interface Speaker {
  speakOutput(output: AccessibleOutput, opts?: { verbosity?: 'short' | 'normal' }): void;
  say(text: string, lang: Lang): void;
  sayLines(lines: { text: string; lang: Lang }[]): void;
  prompt(text: string, lang: Lang): void;
  /** A short sound (listening cue) played like a prompt: a paused answer stays paused. */
  cue(key: string, text: string, lang: Lang): void;
  pause(): void;
  resume(): void;
  repeatSentence(): void;
  repeatAll(): void;
  back(): void;
  nextSection(): void;
  previousSection(): void;
  stop(): void;
  setRate(rate: number): void;
  /** Where the current answer is (prompts and setup lines are not answers); null when idle. */
  snapshot(): PlayerSnapshot | null;
  /** Hold a saved position as a paused answer; Resume restores it. */
  offerResume(snap: PlayerSnapshot): void;
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
  let interrupted: { snap: PlayerSnapshot; playing: boolean; sentence: string | null } | null =
    null;
  let inPrompt = false;
  /** Remaining lines for sayLines(). */
  let lines: { text: string; lang: Lang }[] = [];
  const noVoice = new Set<Lang>();
  // Report the speaker's state, not the player's: an answer paused behind a finished prompt is
  // still "paused" (the bar keeps its Resume button), even though the player itself is idle.
  const emit = () =>
    listeners.forEach((l) => l(player.state === 'playing', speaker.state, sentence));

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
          if (interrupted) sentence = interrupted.sentence; // show the answer's sentence again
          emit();
        }
      }
    }
  });

  /**
   * Playback controls act on the answer: if a prompt is playing over it (or it waits paused
   * behind a finished prompt), go back to the answer first.
   */
  function onAnswer(action: () => void): void {
    if (interrupted && (inPrompt || player.state === 'idle')) {
      const { snap } = interrupted;
      interrupted = null;
      inPrompt = false;
      player.restore(snap);
    }
    action();
  }

  /** A prompt or cue over an answer: keep the answer to carry on (or stay paused) afterwards. */
  function startPrompt(): void {
    const snap = player.snapshot();
    if (snap && !inPrompt && player.state !== 'idle') {
      interrupted = { snap, playing: player.state === 'playing', sentence };
    }
    inPrompt = true;
    lines = [];
  }

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
      startPrompt();
      playOne(text, l);
    },
    cue(key, text, l) {
      startPrompt();
      lang = l;
      player.play([{ segments: [{ text, key }] }], l);
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
      onAnswer(() => player.repeatSentence());
    },
    repeatAll() {
      onAnswer(() => player.repeatAll());
    },
    back() {
      onAnswer(() => player.back());
    },
    nextSection() {
      onAnswer(() => player.nextSection());
    },
    previousSection() {
      onAnswer(() => player.previousSection());
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
    snapshot() {
      if (inPrompt) return interrupted?.snap ?? null;
      if (lines.length > 0) return null;
      return player.snapshot();
    },
    offerResume(snap) {
      if (player.state !== 'idle') return; // something newer is already playing
      interrupted = { snap, playing: false, sentence: null };
      emit();
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
