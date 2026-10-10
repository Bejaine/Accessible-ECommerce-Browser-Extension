// The assistant's own voice: speaks AccessibleOutput section by section, sentence by sentence,
// at the user's speech rate, with the playback controls from docs/conditions.md (pause, resume,
// repeat sentence / all, back one sentence, next / previous section, slower, faster, stop).
// This is Track D's spoken renderer standing in for Track A's player.ts (still a stub): same
// job, behind an interface the player can take over.
//
// Voices: the backend's /speech/tts (Bhashini) when a real backend is connected, otherwise the
// device's own speech engine (Web Speech API; on Linux via speech-dispatcher). Replays and rate
// changes never call TTS again: backend audio is cached per (text, lang) and played with
// playbackRate; device speech restarts the current sentence at the new rate. Pausing stops at
// the current sentence and resuming starts it again (reliable on every engine).
import type { AccessibleOutput, Lang } from '@shared/index';
import { toSpokenSections } from './speech';

export type PlaybackState = 'idle' | 'playing' | 'paused';

export interface SpeakerDeps {
  /** Backend TTS; omit for device speech only. Must resolve base64 WAV/MP3/OGG audio. */
  tts?: (text: string, lang: Lang) => Promise<{ audio_base64: string; encoding: string }>;
  /** Injectable for tests. */
  synth?: SpeechSynthesis | null;
  createAudio?: (src: string) => HTMLAudioElement;
  /** Called once per language that has no device voice (so the app can say so). */
  onNoVoice?: (lang: Lang) => void;
}

/**
 * The best device voice for a language: on-device voices first (nothing leaves the machine),
 * then online ones (e.g. Chrome's Google voices, which send the text to Google), preferring the
 * Indian variant. Null when the device has no voice for the language at all: reading Telugu with
 * an English voice would be gibberish, so we don't.
 */
export function pickVoice(voices: SpeechSynthesisVoice[], lang: Lang): SpeechSynthesisVoice | null {
  const base = lang.toLowerCase();
  const matching = voices.filter(
    (v) => v.lang.toLowerCase().replace('_', '-').split('-')[0] === base,
  );
  const score = (v: SpeechSynthesisVoice) =>
    (v.localService ? 0 : 2) + (v.lang.toLowerCase().replace('_', '-') === `${base}-in` ? 0 : 1);
  return matching.sort((a, b) => score(a) - score(b))[0] ?? null;
}

/** Chrome fills its voice list a moment after load; wait for it (briefly) the first time. */
function loadVoices(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const now = synth.getVoices();
  if (now.length > 0 || typeof synth.addEventListener !== 'function') return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      synth.removeEventListener('voiceschanged', done);
      resolve(synth.getVoices());
    };
    synth.addEventListener('voiceschanged', done);
    setTimeout(done, 1000);
  });
}

export interface Speaker {
  /** Speak an answer (summary first, then sections), replacing whatever is playing. */
  speakOutput(output: AccessibleOutput, opts?: { verbosity?: 'short' | 'normal' }): void;
  /** Speak one short message as the new "answer" (replaces the queue). */
  say(text: string, lang: Lang): void;
  /** Speak several lines in turn, each in its own language (e.g. a multilingual prompt). */
  sayLines(lines: { text: string; lang: Lang }[]): void;
  /**
   * Speak a short prompt (announcement, menu item) over the current answer without losing it:
   * a playing answer resumes at its current sentence afterwards; a paused one stays paused.
   */
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
  /** The sentence being (or last) spoken, for the highlighted line in the overlay. */
  readonly sentence: string | null;
  /** Called when the state or the current sentence changes. */
  onChange(
    listener: (speaking: boolean, state: PlaybackState, sentence: string | null) => void,
  ): () => void;
}

/**
 * Split into sentences, joining two short ones (fewer, smoother TTS calls). A boundary needs
 * whitespace after the punctuation, so numbers like 1.1×, 6.67 inches or ₹17,999.50 stay whole.
 */
export function sentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?।])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const SHORT = 40;
  const out: string[] = [];
  for (const part of parts) {
    const last = out.at(-1);
    if (last && last.length < SHORT && part.length < SHORT) out[out.length - 1] = `${last} ${part}`;
    else out.push(part);
  }
  return out;
}

interface Item {
  text: string;
  lang: Lang;
  section: number;
}

export function createSpeaker(deps: SpeakerDeps = {}): Speaker {
  const synth = deps.synth === undefined ? (globalThis.speechSynthesis ?? null) : deps.synth;
  const makeAudio = deps.createAudio ?? ((src: string) => new Audio(src));
  const cache = new Map<string, string>();
  const listeners = new Set<
    (speaking: boolean, state: PlaybackState, sentence: string | null) => void
  >();
  let queue: Item[] = [];
  let index = 0;
  let state: PlaybackState = 'idle';
  let rate = 1;
  let generation = 0;
  let audio: HTMLAudioElement | null = null;
  let current: { item: Item; restart: () => void } | null = null;

  const sentenceNow = () => queue[index]?.text ?? null;
  function emit(): void {
    listeners.forEach((l) => l(state === 'playing', state, sentenceNow()));
  }
  function setState(next: PlaybackState): void {
    state = next;
    emit();
  }

  /** Stop whatever sound is playing (answer or prompt). */
  function silence(): void {
    generation++;
    current = null;
    synth?.cancel();
    if (audio) {
      audio.pause();
      audio = null;
    }
  }

  /** Speak one item, then call `done` (unless superseded). */
  async function speakItem(item: Item, gen: number, done: () => void): Promise<void> {
    current = { item, restart: () => void speakItem(item, ++generation, done) };
    if (deps.tts) {
      try {
        const key = `${item.lang}|${item.text}`;
        let src = cache.get(key);
        if (!src) {
          const res = await deps.tts(item.text, item.lang);
          src = `data:audio/${res.encoding};base64,${res.audio_base64}`;
          cache.set(key, src);
        }
        if (gen !== generation) return;
        const el = makeAudio(src);
        audio = el;
        el.playbackRate = rate;
        el.onended = () => gen === generation && done();
        el.onerror = () => gen === generation && void deviceSpeak(item, gen, done);
        await el.play();
        return;
      } catch {
        if (gen !== generation) return;
      }
    }
    await deviceSpeak(item, gen, done);
  }

  const missingVoice = new Set<Lang>();

  async function deviceSpeak(item: Item, gen: number, done: () => void): Promise<void> {
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
      done();
      return;
    }
    let voice: SpeechSynthesisVoice | null = null;
    if (typeof synth.getVoices === 'function') {
      voice = pickVoice(await loadVoices(synth), item.lang);
      if (gen !== generation) return;
      if (!voice) {
        // No voice for this language on this device: the text stays on screen and in the live
        // region (screen readers), and the app tells the user once.
        if (!missingVoice.has(item.lang)) {
          missingVoice.add(item.lang);
          deps.onNoVoice?.(item.lang);
        }
        done();
        return;
      }
    }
    const u = new SpeechSynthesisUtterance(item.text);
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? (item.lang === 'en' ? 'en-IN' : `${item.lang}-IN`);
    u.rate = rate;
    u.onend = () => gen === generation && done();
    u.onerror = () => gen === generation && done();
    synth.speak(u);
  }

  /** Play the answer queue from `index`. */
  function playQueue(): void {
    silence();
    const gen = generation;
    const step = () => {
      const item = queue[index];
      if (!item) {
        setState('idle');
        return;
      }
      if (state !== 'playing') setState('playing');
      else emit();
      void speakItem(item, gen, () => {
        index++;
        step();
      });
    };
    step();
  }

  function load(items: Item[]): void {
    queue = items;
    index = 0;
    state = 'playing';
    playQueue();
  }

  const toItems = (lines: { text: string; lang: Lang; section?: number }[]): Item[] =>
    lines.flatMap((l) =>
      sentences(l.text).map((text) => ({ text, lang: l.lang, section: l.section ?? 0 })),
    );

  function jumpTo(i: number): void {
    if (queue.length === 0) return;
    index = Math.max(0, Math.min(queue.length - 1, i));
    state = 'playing';
    playQueue();
  }

  const sectionStart = (i: number) => {
    const s = queue[i]?.section;
    let j = i;
    while (j > 0 && queue[j - 1]!.section === s) j--;
    return j;
  };

  return {
    speakOutput(output, opts = {}) {
      load(
        toItems(
          toSpokenSections(output, { verbosity: opts.verbosity }).flatMap((s, section) =>
            [...(s.heading ? [s.heading] : []), ...s.lines].map((text) => ({
              text,
              lang: output.lang,
              section,
            })),
          ),
        ),
      );
    },
    say(text, lang) {
      load(toItems([{ text, lang }]));
    },
    sayLines(lines) {
      load(toItems(lines));
    },
    prompt(text, lang) {
      const resumeAfter = state === 'playing';
      silence();
      const gen = generation;
      const items = toItems([{ text, lang }]);
      let i = 0;
      const step = () => {
        const item = items[i++];
        if (!item) {
          if (resumeAfter && state === 'playing') playQueue();
          return;
        }
        void speakItem(item, gen, step);
      };
      step();
    },
    pause() {
      if (state !== 'playing') return;
      silence();
      setState('paused');
    },
    resume() {
      if (state !== 'paused' || queue.length === 0) return;
      state = 'playing';
      playQueue();
    },
    repeatSentence() {
      jumpTo(index);
    },
    repeatAll() {
      jumpTo(0);
    },
    back() {
      jumpTo(index - 1);
    },
    nextSection() {
      const s = queue[index]?.section;
      const next = queue.findIndex((item, i) => i > index && item.section !== s);
      if (next >= 0) jumpTo(next);
    },
    previousSection() {
      const start = sectionStart(index);
      jumpTo(index > start ? start : sectionStart(Math.max(0, start - 1)));
    },
    stop() {
      silence();
      queue = [];
      index = 0;
      setState('idle');
    },
    setRate(value) {
      if (value === rate) return;
      rate = value;
      if (audio) audio.playbackRate = rate;
      else if (current && synth) current.restart(); // device voice: restart the sentence
    },
    get state() {
      return state;
    },
    get speaking() {
      return state === 'playing';
    },
    get sentence() {
      return sentenceNow();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
