// Energy-based voice activity detection (Track A), frame by frame. Pure and clock-free: time
// is counted in frames, so behaviour is identical in tests and in the browser.
//
// - Learns the room's noise floor from the first 200 ms, then tracks it while waiting.
// - Speech starts after 200 ms of frames 12 dB above the floor (clicks and taps are ignored).
// - Speech ends after `silenceMs` below floor + 6 dB (hysteresis), never at a short pause.
//   docs/conditions.md: 1.0 s by default, 2.5 s in speech mode.
// - Keeps 300 ms before the start (first syllable) and 300 ms after the last voice.

export type VadEndReason = 'silence' | 'max_length' | 'no_speech';

export interface VadOptions {
  sampleRate: number;
  frameMs: number;
  silenceMs: number;
  /** End and send what we have: the ASR accepts about 20 s. */
  maxUtteranceMs: number;
  /** Give up if nobody speaks for this long; null waits indefinitely. */
  noSpeechMs: number | null;
}

export interface VadStart {
  type: 'start';
  startFrame: number;
}

export interface VadEnd {
  type: 'end';
  reason: VadEndReason;
  /** Frames [startFrame, endFrame) hold the utterance, pre-roll and tail included. */
  startFrame: number;
  endFrame: number;
  /** 0–1: mean level of the voiced frames (or of all frames if there was no speech). Sent as
   *  asr_meta.mic_level so the backend can tell silence from speech it could not recognise. */
  micLevel: number;
}

export interface Vad {
  push(frame: Float32Array): VadStart | VadEnd | null;
  /** Level of the last frame, 0–1, for a meter. */
  readonly level: number;
  readonly speaking: boolean;
}

const CALIBRATION_MS = 200;
const MIN_SPEECH_MS = 200;
const PRE_ROLL_MS = 300;
const TAIL_MS = 300;
const START_MARGIN_DB = 12;
const STOP_MARGIN_DB = 6;
const ABSOLUTE_MIN_DB = -55; // quieter than this is never speech, whatever the room
const LEVEL_FLOOR_DB = -60; // level 0 at -60 dBFS, 1 at 0 dBFS

export const VAD_DEFAULTS: Omit<VadOptions, 'sampleRate'> = {
  frameMs: 20,
  silenceMs: 1000,
  maxUtteranceMs: 19000,
  noSpeechMs: null,
};

export function frameDb(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += (frame[i] ?? 0) ** 2;
  return 20 * Math.log10(Math.sqrt(sum / Math.max(1, frame.length)) + 1e-10);
}

export function dbToLevel(db: number): number {
  return Math.max(0, Math.min(1, (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB));
}

export function createVad(options: Partial<VadOptions> & { sampleRate: number }): Vad {
  const o = { ...VAD_DEFAULTS, ...options };
  const frames = (ms: number) => Math.max(1, Math.round(ms / o.frameMs));
  const calibration = frames(CALIBRATION_MS);
  const minSpeech = frames(MIN_SPEECH_MS);

  let index = -1; // index of the frame being processed
  let floor: number | null = null;
  let calibrationSum = 0;
  let state: 'waiting' | 'speaking' | 'ended' = 'waiting';
  let run = 0; // consecutive voiced frames while waiting
  let startFrame = 0;
  let lastVoiced = 0;
  let voicedLevelSum = 0;
  let voicedCount = 0;
  let allLevelSum = 0;
  let level = 0;

  const end = (reason: VadEndReason, endFrame: number): VadEnd => {
    state = 'ended';
    const micLevel = voicedCount > 0 ? voicedLevelSum / voicedCount : allLevelSum / (index + 1);
    return { type: 'end', reason, startFrame, endFrame, micLevel: round2(micLevel) };
  };

  return {
    get level() {
      return level;
    },
    get speaking() {
      return state === 'speaking';
    },
    push(frame) {
      if (state === 'ended') return null;
      index++;
      const db = frameDb(frame);
      level = dbToLevel(db);
      allLevelSum += level;

      if (index < calibration) {
        calibrationSum += db;
        if (index === calibration - 1) floor = calibrationSum / calibration;
      }
      const noise = floor ?? LEVEL_FLOOR_DB;

      if (state === 'waiting') {
        const voiced = floor !== null && db > Math.max(noise + START_MARGIN_DB, ABSOLUTE_MIN_DB);
        run = voiced ? run + 1 : 0;
        if (voiced) {
          voicedLevelSum += level;
          voicedCount++;
        } else {
          voicedLevelSum = 0;
          voicedCount = 0;
          // Track the room: follow quiet quickly, louder noise slowly.
          if (floor !== null) floor += (db - floor) * (db < floor ? 0.3 : 0.01);
        }
        if (run >= minSpeech) {
          state = 'speaking';
          startFrame = Math.max(0, index - run + 1 - frames(PRE_ROLL_MS));
          lastVoiced = index;
          return { type: 'start', startFrame };
        }
        if (o.noSpeechMs !== null && (index + 1) * o.frameMs >= o.noSpeechMs) {
          startFrame = index + 1;
          voicedCount = 0;
          return end('no_speech', index + 1);
        }
        return null;
      }

      // speaking
      if (db > Math.max(noise + STOP_MARGIN_DB, ABSOLUTE_MIN_DB - 5)) {
        lastVoiced = index;
        voicedLevelSum += level;
        voicedCount++;
      }
      if ((index + 1 - startFrame) * o.frameMs >= o.maxUtteranceMs) {
        return end('max_length', index + 1);
      }
      if ((index - lastVoiced) * o.frameMs >= o.silenceMs) {
        return end('silence', Math.min(index + 1, lastVoiced + 1 + frames(TAIL_MS)));
      }
      return null;
    },
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
