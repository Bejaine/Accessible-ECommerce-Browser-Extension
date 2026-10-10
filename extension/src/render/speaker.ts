// The assistant's own voice: speaks AccessibleOutput section by section, sentence by sentence,
// at the user's speech rate. This is Track D's spoken renderer standing in for Track A's
// player.ts (still a stub): same job, behind a small interface the player can take over.
//
// Voices: the backend's /speech/tts (Bhashini) when a real backend is connected, otherwise the
// device's own speech engine (Web Speech API; on Linux via speech-dispatcher). Replays and rate
// changes never call TTS again: backend audio is cached per (text, lang) and played with
// playbackRate; device speech restarts the current sentence at the new rate.
import type { AccessibleOutput, Lang } from '@shared/index';
import { toSpokenSections } from './speech';

export interface SpeakerDeps {
  /** Backend TTS; omit for device speech only. Must resolve base64 WAV/MP3/OGG audio. */
  tts?: (text: string, lang: Lang) => Promise<{ audio_base64: string; encoding: string }>;
  /** Injectable for tests. */
  synth?: SpeechSynthesis | null;
  createAudio?: (src: string) => HTMLAudioElement;
}

export interface Speaker {
  /** Speak an answer (summary first), replacing whatever is playing. */
  speakOutput(output: AccessibleOutput, opts?: { verbosity?: 'short' | 'normal' }): void;
  /** Speak one short message (announcements, prompts), replacing whatever is playing. */
  say(text: string, lang: Lang): void;
  /** Speak several lines in turn, each in its own language (e.g. a multilingual prompt). */
  sayLines(lines: { text: string; lang: Lang }[]): void;
  stop(): void;
  setRate(rate: number): void;
  readonly speaking: boolean;
  /** Called when playback starts or stops (e.g. to flip a Read aloud / Stop button). */
  onChange(listener: (speaking: boolean) => void): () => void;
}

/** Split into sentences, keeping short ones together (fewer, smoother TTS calls). */
export function sentences(text: string): string[] {
  const parts =
    text
      .match(/[^.!?।]+[.!?।]*\s*/g)
      ?.map((s) => s.trim())
      .filter(Boolean) ?? [];
  const out: string[] = [];
  for (const part of parts) {
    const last = out.at(-1);
    if (last && last.length < 40) out[out.length - 1] = `${last} ${part}`;
    else out.push(part);
  }
  return out;
}

export function createSpeaker(deps: SpeakerDeps = {}): Speaker {
  const synth = deps.synth === undefined ? (globalThis.speechSynthesis ?? null) : deps.synth;
  const makeAudio = deps.createAudio ?? ((src: string) => new Audio(src));
  const cache = new Map<string, string>();
  const listeners = new Set<(speaking: boolean) => void>();
  let queue: { text: string; lang: Lang }[] = [];
  let index = 0;
  let rate = 1;
  let generation = 0;
  let audio: HTMLAudioElement | null = null;
  let speaking = false;

  function setSpeaking(value: boolean): void {
    if (speaking === value) return;
    speaking = value;
    listeners.forEach((l) => l(value));
  }

  function halt(): void {
    generation++;
    synth?.cancel();
    if (audio) {
      audio.pause();
      audio = null;
    }
  }

  async function play(gen: number): Promise<void> {
    const item = queue[index];
    if (gen !== generation) return;
    if (!item) {
      setSpeaking(false);
      return;
    }
    setSpeaking(true);
    const next = () => {
      if (gen !== generation) return;
      index++;
      void play(gen);
    };
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
        audio = makeAudio(src);
        audio.playbackRate = rate;
        audio.onended = next;
        audio.onerror = () => deviceSpeak(item, next);
        await audio.play();
        return;
      } catch {
        // Fall through to the device voice.
      }
    }
    deviceSpeak(item, next);
  }

  function deviceSpeak(item: { text: string; lang: Lang }, next: () => void): void {
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
      next();
      return;
    }
    const u = new SpeechSynthesisUtterance(item.text);
    u.lang = item.lang === 'en' ? 'en-IN' : `${item.lang}-IN`;
    u.rate = rate;
    u.onend = next;
    u.onerror = next;
    synth.speak(u);
  }

  function start(items: { text: string; lang: Lang }[]): void {
    halt();
    queue = items;
    index = 0;
    void play(generation);
  }

  return {
    speakOutput(output, opts = {}) {
      const items = toSpokenSections(output, { verbosity: opts.verbosity }).flatMap((s) =>
        [...(s.heading ? [s.heading] : []), ...s.lines].flatMap((line) =>
          sentences(line).map((text) => ({ text, lang: output.lang })),
        ),
      );
      start(items);
    },
    say(text, lang) {
      start(sentences(text).map((t) => ({ text: t, lang })));
    },
    sayLines(lines) {
      start(lines.flatMap((l) => sentences(l.text).map((text) => ({ text, lang: l.lang }))));
    },
    stop() {
      halt();
      queue = [];
      setSpeaking(false);
    },
    setRate(value) {
      if (value === rate) return;
      rate = value;
      if (audio) {
        audio.playbackRate = rate;
      } else if (speaking && synth) {
        // Device speech can't change rate mid-utterance: restart the current sentence.
        halt();
        void play(generation);
      }
    },
    get speaking() {
      return speaking;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
