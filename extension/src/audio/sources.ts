// Where each spoken segment's audio comes from (Track A), in order:
//   1. a pre-recorded UI phrase (instant), 2. this session's cache (rule 12: a replay never
//   calls TTS again), 3. the device voice in lite mode, 4. server TTS (3–19 s live, so the
//   player prefetches the next segment), 5. the device voice if the server fails or is slow
//   (announced once), 6. nothing that can speak this language: show the text.
// After two server failures in a row the device voice is used for a minute before retrying.
import type { Lang } from '@shared/index';
import { bytesFromBase64 } from './wav';

export interface Segment {
  text: string;
  lang: Lang;
  /** UI string key, if the text is one (e.g. "cart.added"): enables pre-recorded audio. */
  key?: string;
}

export type SpeechSource =
  | { kind: 'audio'; url: string; from: 'phrase' | 'cache' | 'server' }
  | { kind: 'device'; voice: SpeechSynthesisVoice; lang: Lang }
  | { kind: 'text' };

export interface SourcesOptions {
  /** Server TTS (the background script's backend.tts); rejects with an ErrorResponse. */
  tts: (text: string, lang: Lang) => Promise<{ audio_base64: string; encoding: string }>;
  /** prefs.lite_mode: device voice only, no server audio. */
  lite: () => boolean;
  voices?: () => Promise<SpeechSynthesisVoice[]>;
  toUrl?: (bytes: Uint8Array, encoding: string) => string;
  revoke?: (url: string) => void;
  phraseUrl?: (key: string, lang: string) => string | null;
  /** Called once when server audio fails and the device voice takes over. */
  onFallback?: () => void;
  clock?: () => number;
  timeoutMs?: number;
}

export interface SpeechSources {
  resolve(segment: Segment): Promise<SpeechSource>;
  /** Start fetching server audio for a segment that will play soon. */
  prefetch(segment: Segment): void;
  /** Forget cached audio (e.g. on leaving the page). */
  clear(): void;
}

const DEGRADED_MS = 60_000;
const FAILURES_BEFORE_DEGRADED = 2;

export function createSpeechSources(options: SourcesOptions): SpeechSources {
  const o = {
    voices: deviceVoices,
    toUrl: blobUrl,
    revoke: (url: string) => URL.revokeObjectURL?.(url),
    phraseUrl: () => null,
    onFallback: () => {},
    clock: () => Date.now(),
    timeoutMs: 25_000, // server TTS times out at 30 s (incl. the S3 download)
    ...options,
  };
  const cache = new Map<string, { url: Promise<string>; played: boolean }>();
  let failures = 0;
  let degradedUntil = 0;
  let announced = false;

  function fetchAudio(seg: Segment): { url: Promise<string>; played: boolean } {
    const k = `${seg.lang}\n${seg.text}`;
    const hit = cache.get(k);
    if (hit) return hit;
    const url = withTimeout(o.tts(seg.text, seg.lang), o.timeoutMs).then(
      (res) => {
        failures = 0;
        return o.toUrl(bytesFromBase64(res.audio_base64), res.encoding);
      },
      (err: unknown) => {
        cache.delete(k); // a failure is not cached: the next attempt tries again
        if (++failures >= FAILURES_BEFORE_DEGRADED) degradedUntil = o.clock() + DEGRADED_MS;
        throw err;
      },
    );
    url.catch(() => {}); // a prefetch nobody awaits must not raise "unhandled rejection"
    const entry = { url, played: false };
    cache.set(k, entry);
    return entry;
  }

  async function device(seg: Segment): Promise<SpeechSource> {
    const voice = pickVoice(await o.voices(), seg.lang);
    return voice ? { kind: 'device', voice, lang: seg.lang } : { kind: 'text' };
  }

  return {
    async resolve(seg) {
      const phrase = seg.key ? o.phraseUrl(seg.key, seg.lang) : null;
      if (phrase) return { kind: 'audio', url: phrase, from: 'phrase' };
      const cached = cache.get(`${seg.lang}\n${seg.text}`);
      if (cached?.played) return { kind: 'audio', url: await cached.url, from: 'cache' };
      if (o.lite() || (!cached && o.clock() < degradedUntil)) return device(seg);
      const entry = fetchAudio(seg);
      try {
        const url = await entry.url;
        entry.played = true;
        return { kind: 'audio', url, from: 'server' };
      } catch {
        if (!announced) {
          announced = true;
          o.onFallback();
        }
        return device(seg);
      }
    },
    prefetch(seg) {
      if (o.lite() || (seg.key && o.phraseUrl(seg.key, seg.lang))) return;
      if (o.clock() < degradedUntil) return;
      fetchAudio(seg);
    },
    clear() {
      for (const { url } of cache.values()) url.then(o.revoke, () => {});
      cache.clear();
    },
  };
}

/** The device voice for a language: the Indian variant first (en-IN), then any variant;
 *  on-device voices before network ones (they work offline). Never an English voice for
 *  Hindi or Telugu: it would read the script wrongly or not at all. */
export function pickVoice(voices: SpeechSynthesisVoice[], lang: Lang): SpeechSynthesisVoice | null {
  const norm = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().replace('_', '-');
  const matching = voices.filter((v) => norm(v).split('-')[0] === lang);
  const score = (v: SpeechSynthesisVoice) =>
    (norm(v) === `${lang}-in` ? 2 : 0) + (v.localService ? 1 : 0);
  return [...matching].sort((a, b) => score(b) - score(a))[0] ?? null;
}

async function deviceVoices(): Promise<SpeechSynthesisVoice[]> {
  if (typeof speechSynthesis === 'undefined') return [];
  const now = speechSynthesis.getVoices();
  if (now.length) return now;
  return new Promise((resolve) => {
    // Chrome loads voices asynchronously; some browsers never fire the event.
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

function blobUrl(bytes: Uint8Array, encoding: string): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: `audio/${encoding}` }));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
