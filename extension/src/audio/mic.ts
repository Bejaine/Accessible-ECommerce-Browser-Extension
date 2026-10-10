// Microphone capture (Track A): one utterance per listen(), as a 16 kHz WAV for /speech/asr.
//
// Runs in the content script. Web Audio via ScriptProcessorNode, not AudioWorklet: a worklet
// loads a module URL, which page CSPs can block (same reason we use no Web Workers).
// The mic is open only while listening, and mute() (secure zone, docs/safety.md) closes it
// immediately and discards the audio.
import type { ASRRequest, Lang } from '@shared/index';
import { createVad, type VadEndReason, VAD_DEFAULTS } from './vad';
import { ASR_SAMPLE_RATE, bytesToBase64, encodeWav, resample } from './wav';

export type ListenMode = 'default' | 'speech';
export type UtteranceReason = VadEndReason | 'stopped' | 'muted';

export interface Utterance {
  reason: UtteranceReason;
  /** 16 kHz mono 16-bit WAV, or null when there was no speech (or it was muted). Kept for
   *  personal enrollment matching (src/match) as well as ASR. */
  wav: Uint8Array | null;
  audioBase64: string | null;
  durationMs: number;
  /** 0–1, for asr_meta.mic_level: near 0 means silence, not unclear speech. */
  micLevel: number;
}

export interface ListenOptions {
  /** 'speech' (unclear speech mode) waits 2.5 s of silence instead of 1.0 s. */
  mode?: ListenMode;
  /** About 10 times a second, 0–1, for a level meter. */
  onLevel?: (level: number) => void;
  onSpeechStart?: () => void;
}

export type MicErrorCode =
  'permission_denied' | 'no_microphone' | 'unavailable' | 'secure_zone' | 'no_audio';

export class MicError extends Error {
  constructor(
    readonly code: MicErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MicError';
  }
}

/** Where audio comes from: the real microphone, or synthetic audio in tests. */
export interface AudioSource {
  readonly sampleRate: number;
  start(onChunk: (chunk: Float32Array) => void): void;
  stop(): void;
}

export interface Mic {
  /** Listen for one utterance. Calling again while listening returns the same promise. */
  listen(options?: ListenOptions): Promise<Utterance>;
  /** End now, keeping what was said so far. */
  stop(): void;
  /** Secure zone: close the mic now, discard the audio, refuse to listen until unmute(). */
  mute(): void;
  unmute(): void;
  readonly listening: boolean;
  readonly muted: boolean;
}

/** docs/conditions.md: silence timeout 1.0 s by default, 2.5 s in speech mode. Speech mode
 *  also waits longer for the user to begin. */
export const MODE_SETTINGS: Record<ListenMode, { silenceMs: number; noSpeechMs: number }> = {
  default: { silenceMs: 1000, noSpeechMs: 15000 },
  speech: { silenceMs: 2500, noSpeechMs: 30000 },
};

const LEVEL_EVERY_FRAMES = 5; // 20 ms frames -> a level update every 100 ms
const KEEP_WHILE_WAITING = 40; // frames (800 ms): enough for pre-roll + the start run

interface Session {
  promise: Promise<Utterance>;
  resolve(u: Utterance): void;
  source: AudioSource | null;
  closed: boolean;
  finish(reason: 'stopped' | 'muted'): void;
}

export function createMic(deps: { openSource?: () => Promise<AudioSource> } = {}): Mic {
  const openSource = deps.openSource ?? openWebAudioSource;
  let current: Session | null = null;
  let muted = false;

  function listen(options: ListenOptions = {}): Promise<Utterance> {
    if (muted) {
      return Promise.reject(new MicError('secure_zone', 'Listening is paused in this field.'));
    }
    if (current) return current.promise;

    const settings = MODE_SETTINGS[options.mode ?? 'default'];
    let resolve!: (u: Utterance) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<Utterance>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    // Native-rate 20 ms frames; while waiting only the last KEEP_WHILE_WAITING are kept.
    const stored: Float32Array[] = [];
    let base = 0; // frame index of stored[0]
    let vad: ReturnType<typeof createVad> | null = null;
    let startFrame = 0;

    const session: Session = {
      promise,
      resolve,
      source: null,
      closed: false,
      finish(reason) {
        if (session.closed) return;
        if (reason === 'muted' || !vad?.speaking) {
          const noSpeech = reason === 'stopped' ? 'no_speech' : reason;
          close(empty(noSpeech, reason === 'muted' ? 0 : (vad?.level ?? 0)));
          return;
        }
        close(build('stopped', startFrame, base + stored.length, vad.level));
      },
    };
    current = session;

    function close(u: Utterance) {
      session.closed = true;
      session.source?.stop();
      if (current === session) current = null;
      resolve(u);
    }

    function build(reason: UtteranceReason, from: number, to: number, micLevel: number) {
      const native = concat(stored.slice(from - base, to - base));
      const samples = resample(
        native,
        session.source?.sampleRate ?? ASR_SAMPLE_RATE,
        ASR_SAMPLE_RATE,
      );
      const wav = encodeWav(samples, ASR_SAMPLE_RATE);
      return {
        reason,
        wav,
        audioBase64: bytesToBase64(wav),
        durationMs: Math.round((samples.length / ASR_SAMPLE_RATE) * 1000),
        micLevel,
      };
    }

    openSource().then(
      (source) => {
        session.source = source;
        if (session.closed) {
          source.stop(); // muted or stopped while the mic was opening
          return;
        }
        vad = createVad({ sampleRate: source.sampleRate, ...settings });
        const frameLen = Math.round((source.sampleRate * VAD_DEFAULTS.frameMs) / 1000);
        let pending: Float32Array = new Float32Array(0);
        let frameIndex = -1;

        source.start((chunk) => {
          if (session.closed || !vad) return;
          pending = concat([pending, chunk]); // copies: the browser may reuse chunk's buffer
          while (pending.length >= frameLen && !session.closed) {
            const frame = pending.slice(0, frameLen);
            pending = pending.subarray(frameLen);
            frameIndex++;
            stored.push(frame);
            const event = vad.push(frame);
            if (frameIndex % LEVEL_EVERY_FRAMES === 0) options.onLevel?.(vad.level);
            if (event?.type === 'start') {
              startFrame = event.startFrame;
              options.onSpeechStart?.();
            } else if (event?.type === 'end') {
              close(
                event.reason === 'no_speech'
                  ? empty('no_speech', event.micLevel)
                  : build(event.reason, event.startFrame, event.endFrame, event.micLevel),
              );
              return;
            }
            if (!vad.speaking && stored.length > KEEP_WHILE_WAITING) {
              const drop = stored.length - KEEP_WHILE_WAITING;
              stored.splice(0, drop);
              base += drop;
            }
          }
        });
      },
      (err: unknown) => {
        session.closed = true;
        if (current === session) current = null;
        reject(toMicError(err));
      },
    );
    return promise;
  }

  return {
    listen,
    stop() {
      current?.finish('stopped');
    },
    mute() {
      muted = true;
      current?.finish('muted');
    },
    unmute() {
      muted = false;
    },
    get listening() {
      return current !== null;
    },
    get muted() {
      return muted;
    },
  };
}

/** The /speech/asr request body for an utterance. */
export function toAsrRequest(u: Utterance, lang: Lang): ASRRequest {
  if (!u.audioBase64) throw new MicError('no_audio', 'There is no speech to send.');
  return {
    schema_version: '1.0',
    lang,
    audio_base64: u.audioBase64,
    encoding: 'wav',
    sample_rate: ASR_SAMPLE_RATE,
    mic_level: u.micLevel,
  };
}

/** The real microphone, with echo cancellation so our own speech output isn't heard back. */
export async function openWebAudioSource(): Promise<AudioSource> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MicError('unavailable', 'This page cannot use the microphone.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  const ctx = new AudioContext();
  await ctx.resume(); // listen() is called from a key press or tap, so this is allowed
  const input = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(2048, 1, 1);
  const sink = ctx.createGain();
  sink.gain.value = 0; // ScriptProcessor only runs when connected to the output; keep it silent
  return {
    sampleRate: ctx.sampleRate,
    start(onChunk) {
      processor.onaudioprocess = (e) => onChunk(e.inputBuffer.getChannelData(0));
      input.connect(processor);
      processor.connect(sink);
      sink.connect(ctx.destination);
    },
    stop() {
      processor.onaudioprocess = null;
      input.disconnect();
      processor.disconnect();
      sink.disconnect();
      stream.getTracks().forEach((t) => t.stop()); // turns off the browser's mic indicator
      void ctx.close();
    },
  };
}

function toMicError(err: unknown): MicError {
  if (err instanceof MicError) return err;
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new MicError('permission_denied', 'Microphone permission was not given.');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new MicError('no_microphone', 'No microphone was found.');
  }
  return new MicError('unavailable', 'The microphone could not be started.');
}

function empty(reason: UtteranceReason, micLevel: number): Utterance {
  return { reason, wav: null, audioBase64: null, durationMs: 0, micLevel };
}

function concat(parts: Float32Array[]): Float32Array {
  if (parts.length === 1 && parts[0]) return parts[0];
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
