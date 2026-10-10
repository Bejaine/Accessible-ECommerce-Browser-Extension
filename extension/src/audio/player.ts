// The one audio player (rule 12, Track A). Plays an answer segment by segment: the next
// segment's audio is fetched while the current one plays (this is our sentence-by-sentence
// streaming; /turn itself does not stream). Controls follow docs/conditions.md and are driven
// by Track D's UI (voice words, the single key, the paused mini-menu):
//   pause/resume/toggle, stop, repeat sentence, repeat all, back, next/previous section,
//   slower/faster (0.5–2, reported so it can be saved in prefs).
// Replays come from the sources' cache: never a new TTS or LLM call.
import type { AccessibleOutput, Lang } from '@shared/index';
import { speechSegments } from './sentences';
import type { SpeechSources } from './sources';

export type PlayerState = 'idle' | 'playing' | 'paused';

export interface PlaySection {
  /** What is spoken, in order; `key` marks a UI string with pre-recorded audio. */
  segments: { text: string; key?: string }[];
}

export type PlayerEvent =
  | { type: 'sentence'; section: number; index: number; text: string }
  | { type: 'state'; state: PlayerState }
  | { type: 'rate'; rate: number }
  | { type: 'text-only'; text: string }
  | { type: 'error'; text: string }
  | { type: 'end' };

/** One playing clip. `done` settles when it ends (or is stopped); rejects if it can't play. */
export interface Playback {
  done: Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  setRate(rate: number): void;
}

export interface Engines {
  audio(url: string, rate: number): Playback;
  device(text: string, voice: SpeechSynthesisVoice, rate: number): Playback;
}

export interface PlayerSnapshot {
  sections: PlaySection[];
  lang: Lang;
  section: number;
  index: number;
}

export interface Player {
  play(sections: PlaySection[], lang: Lang): void;
  /** Summary, then each section's heading, items and spoken table. Follow-up chips are the
   *  UI's to present. */
  playOutput(output: AccessibleOutput): void;
  pause(): void;
  resume(): void;
  /** The single key: pause when playing, resume when paused. */
  toggle(): void;
  stop(): void;
  repeatSentence(): void;
  repeatAll(): void;
  back(): void;
  nextSection(): void;
  previousSection(): void;
  slower(): void;
  faster(): void;
  readonly state: PlayerState;
  readonly rate: number;
  /** Where playback is, to offer "resume where it stopped" after a page change. */
  snapshot(): PlayerSnapshot | null;
  restore(snapshot: PlayerSnapshot): void;
}

export const MIN_RATE = 0.5;
export const MAX_RATE = 2;
const RATE_STEP = 0.25;

interface Item {
  section: number;
  index: number;
  text: string;
  key?: string;
}

export function createPlayer(deps: {
  sources: SpeechSources;
  engines?: Engines;
  /** Starting speed, from prefs.tts_rate. */
  rate?: number;
  onEvent?: (event: PlayerEvent) => void;
}): Player {
  const engines = deps.engines ?? browserEngines();
  const emit = deps.onEvent ?? (() => {});
  let sections: PlaySection[] = [];
  let lang: Lang = 'en';
  let items: Item[] = [];
  let pos = 0;
  let state: PlayerState = 'idle';
  let rate = clampRate(deps.rate ?? 1);
  let generation = 0; // bumped by every jump/stop: an older loop sees it and quits
  let current: Playback | null = null;

  function setState(next: PlayerState) {
    if (next === state) return;
    state = next;
    emit({ type: 'state', state });
  }

  function load(next: PlaySection[], nextLang: Lang) {
    sections = next;
    lang = nextLang;
    items = next.flatMap((s, section) =>
      s.segments.map((seg, index) => ({ section, index, ...seg })),
    );
  }

  async function run(gen: number) {
    while (gen === generation && pos < items.length) {
      const item = items[pos] as Item;
      const next = items[pos + 1];
      if (next) deps.sources.prefetch({ text: next.text, lang, key: next.key });
      const source = await deps.sources.resolve({ text: item.text, lang, key: item.key });
      if (gen !== generation) return;
      emit({ type: 'sentence', section: item.section, index: item.index, text: item.text });
      if (source.kind === 'text') {
        emit({ type: 'text-only', text: item.text });
        pos++;
        continue;
      }
      const clip =
        source.kind === 'audio'
          ? engines.audio(source.url, rate)
          : engines.device(item.text, source.voice, rate);
      current = clip;
      if (state === 'paused') clip.pause(); // paused while the audio was being fetched
      try {
        await clip.done;
      } catch {
        if (gen !== generation) return;
        emit({ type: 'error', text: item.text });
      }
      if (gen !== generation) return;
      current = null;
      pos++;
    }
    if (gen === generation) {
      setState('idle');
      emit({ type: 'end' });
    }
  }

  function jump(to: number) {
    if (!items.length) return;
    generation++;
    current?.stop();
    current = null;
    pos = Math.max(0, Math.min(to, items.length - 1));
    setState('playing');
    void run(generation);
  }

  function sectionStart(section: number) {
    return items.findIndex((i) => i.section === section);
  }

  function setRate(next: number) {
    rate = clampRate(next);
    current?.setRate(rate);
    emit({ type: 'rate', rate });
  }

  const player: Player = {
    play(next, nextLang) {
      load(next, nextLang);
      jump(0);
    },
    playOutput(output) {
      const parts: PlaySection[] = [
        { segments: speechSegments(output.summary).map((text) => ({ text })) },
      ];
      for (const s of output.sections) {
        const segments = [
          ...(s.heading.trim() ? [s.heading.trim()] : []),
          ...s.items.flatMap((item) => speechSegments(item.text)),
          ...(s.table?.spoken ? speechSegments(s.table.spoken) : []),
        ];
        if (segments.length) parts.push({ segments: segments.map((text) => ({ text })) });
      }
      player.play(parts, output.lang);
    },
    pause() {
      if (state !== 'playing') return;
      setState('paused');
      current?.pause();
    },
    resume() {
      if (state !== 'paused') return;
      setState('playing');
      current?.resume();
    },
    toggle() {
      if (state === 'playing') player.pause();
      else if (state === 'paused') player.resume();
    },
    stop() {
      generation++;
      current?.stop();
      current = null;
      setState('idle');
    },
    repeatSentence: () => jump(pos),
    repeatAll: () => jump(0),
    back: () => jump(pos - 1),
    nextSection() {
      const at = items[pos]?.section ?? 0;
      const next = items.findIndex((i) => i.section > at);
      if (next >= 0) jump(next);
    },
    previousSection() {
      const at = items[pos]?.section ?? 0;
      const start = sectionStart(at);
      if (pos > start) jump(start);
      else jump(Math.max(0, sectionStart(at - 1)));
    },
    slower: () => setRate(rate - RATE_STEP),
    faster: () => setRate(rate + RATE_STEP),
    get state() {
      return state;
    },
    get rate() {
      return rate;
    },
    snapshot() {
      const item = items[pos];
      if (state === 'idle' || !item) return null;
      return { sections, lang, section: item.section, index: item.index };
    },
    restore(snap) {
      load(snap.sections, snap.lang);
      const at = items.findIndex((i) => i.section === snap.section && i.index === snap.index);
      jump(Math.max(0, at));
    },
  };
  return player;
}

function clampRate(rate: number): number {
  const stepped = Math.round(rate / RATE_STEP) * RATE_STEP;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, stepped));
}

/** Real playback: an <audio> element (pitch kept when the speed changes) or the device voice. */
export function browserEngines(): Engines {
  return {
    audio(url, rate) {
      const el = new Audio(url);
      el.preservesPitch = true;
      el.playbackRate = rate;
      let settle!: () => void;
      const done = new Promise<void>((resolve, reject) => {
        settle = resolve;
        el.onended = () => resolve();
        el.onerror = () => reject(new Error('audio could not be played'));
        el.play().catch(reject); // e.g. blocked autoplay: reported, then skipped
      });
      return {
        done,
        pause: () => el.pause(),
        resume: () => void el.play().catch(() => {}),
        stop: () => {
          el.pause();
          settle();
        },
        setRate: (r) => {
          el.playbackRate = r;
        },
      };
    },
    device(text, voice, rate) {
      const u = new SpeechSynthesisUtterance(text);
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = rate; // applies to the next utterance if changed mid-way
      const done = new Promise<void>((resolve, reject) => {
        u.onend = () => resolve();
        u.onerror = (e) =>
          e.error === 'interrupted' || e.error === 'canceled'
            ? resolve()
            : reject(new Error(e.error));
      });
      speechSynthesis.speak(u);
      return {
        done,
        pause: () => speechSynthesis.pause(),
        resume: () => speechSynthesis.resume(),
        stop: () => speechSynthesis.cancel(),
        setRate: () => {},
      };
    },
  };
}
