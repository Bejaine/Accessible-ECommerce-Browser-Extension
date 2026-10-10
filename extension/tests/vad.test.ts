import { describe, expect, it } from 'vitest';
import { createVad, type VadEnd, type VadOptions } from '../src/audio/vad';
import { concat, hiss, tone } from './audio-helpers';

const RATE = 16000;
const FRAME = RATE / 50; // 20 ms

/** Feed audio frame by frame; return the end event (if any) and when speech started. */
function run(audio: Float32Array, opts: Partial<VadOptions> = {}) {
  const vad = createVad({ sampleRate: RATE, ...opts });
  let started: number | null = null;
  let end: VadEnd | null = null;
  for (let i = 0; i + FRAME <= audio.length && !end; i += FRAME) {
    const ev = vad.push(audio.subarray(i, i + FRAME));
    if (ev?.type === 'start') started = i / RATE;
    if (ev?.type === 'end') end = ev;
  }
  return { vad, started, end };
}

describe('vad', () => {
  it('ends an utterance after 1.0 s of silence by default', () => {
    const { started, end } = run(concat(hiss(0.5, RATE), tone(1, RATE), hiss(3, RATE)));
    expect(started).toBeCloseTo(0.7, 1); // 200 ms of voice before it counts as speech
    expect(end?.reason).toBe('silence');
    // 300 ms pre-roll before the voice, the voice, 300 ms of tail kept after it
    expect(end && (end.endFrame - end.startFrame) * 0.02).toBeCloseTo(1.6, 1);
  });

  it('waits 2.5 s of silence in speech mode (unclear speech, long pauses)', () => {
    const audio = concat(hiss(0.5, RATE), tone(1, RATE), hiss(2, RATE), tone(0.5, RATE));
    const speech = run(audio, { silenceMs: 2500 });
    expect(speech.end).toBeNull(); // the 2 s pause did not end it
    const normal = run(audio);
    expect(normal.end?.reason).toBe('silence');
  });

  it('never cuts a user off at a short pause', () => {
    const audio = concat(hiss(0.5, RATE), tone(1, RATE), hiss(0.6, RATE), tone(1, RATE));
    expect(run(audio).end).toBeNull();
  });

  it('ignores a click shorter than 200 ms', () => {
    const audio = concat(hiss(0.5, RATE), tone(0.1, RATE), hiss(2, RATE));
    expect(run(audio).started).toBeNull();
  });

  it('does not mistake a steady hum for speech', () => {
    const hum = tone(5, RATE, 0.02, 50);
    expect(run(hum).started).toBeNull();
  });

  it('still hears speech over that hum', () => {
    const audio = concat(tone(1, RATE, 0.02, 50), tone(1, RATE, 0.3), hiss(1.5, RATE));
    expect(run(audio).end?.reason).toBe('silence');
  });

  it('stops at the ASR length limit', () => {
    const { end } = run(concat(hiss(0.5, RATE), tone(25, RATE)), { maxUtteranceMs: 19000 });
    expect(end?.reason).toBe('max_length');
    expect(end && (end.endFrame - end.startFrame) * 0.02).toBeLessThanOrEqual(19);
  });

  it('gives up when nobody speaks', () => {
    const { end } = run(hiss(16, RATE), { noSpeechMs: 15000 });
    expect(end?.reason).toBe('no_speech');
    expect(end?.micLevel).toBeLessThan(0.15);
  });

  it('reports a high mic level for speech and a low one for silence', () => {
    const loud = run(concat(hiss(0.5, RATE), tone(1, RATE, 0.3), hiss(1.5, RATE))).end;
    const quiet = run(concat(hiss(0.5, RATE), tone(1, RATE, 0.02), hiss(1.5, RATE))).end;
    expect(loud?.micLevel).toBeGreaterThan(0.7);
    expect(quiet?.micLevel).toBeGreaterThan(0.2); // quiet speech still clearly above silence
    expect(quiet?.micLevel).toBeLessThan(loud?.micLevel ?? 0);
  });

  it('exposes a live 0–1 level for a meter', () => {
    const { vad } = run(tone(0.5, RATE));
    expect(vad.level).toBeGreaterThan(0.7);
  });
});
