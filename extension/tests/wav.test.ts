import { describe, expect, it } from 'vitest';
import { bytesToBase64, encodeWav, resample } from '../src/audio/wav';
import { readWav, tone } from './audio-helpers';

describe('encodeWav', () => {
  it('writes a 16-bit mono PCM WAV header the ASR accepts', () => {
    const wav = readWav(encodeWav(new Float32Array(1600), 16000));
    expect(wav).toMatchObject({
      riff: 'RIFF',
      wave: 'WAVE',
      format: 1,
      channels: 1,
      sampleRate: 16000,
      bits: 16,
      dataBytes: 3200,
    });
    expect(wav.seconds).toBeCloseTo(0.1);
  });

  it('converts and clamps samples to 16-bit', () => {
    const wav = readWav(encodeWav(Float32Array.from([0, 1, -1, 2, -2, 0.5]), 16000));
    expect([0, 1, 2, 3, 4, 5].map(wav.sample)).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });
});

describe('resample', () => {
  it('turns 48 kHz into 16 kHz with a third of the samples', () => {
    expect(resample(new Float32Array(48000), 48000, 16000)).toHaveLength(16000);
  });

  it('handles rates that are not a whole multiple (44.1 kHz)', () => {
    expect(resample(new Float32Array(44100), 44100, 16000)).toHaveLength(16000);
  });

  it('keeps a speech-band tone at the same pitch and loudness', () => {
    const out = resample(tone(1, 48000, 0.5, 1000), 48000, 16000);
    let crossings = 0;
    for (let i = 1; i < out.length; i++)
      if ((out[i - 1] ?? 0) < 0 !== (out[i] ?? 0) < 0) crossings++;
    expect(crossings).toBeGreaterThan(1990); // a 1 kHz tone crosses zero ~2000 times a second
    expect(crossings).toBeLessThan(2010);
    expect(Math.max(...out)).toBeGreaterThan(0.45);
  });

  it('returns the input unchanged when the rate already matches', () => {
    const input = tone(0.1, 16000);
    expect(resample(input, 16000, 16000)).toBe(input);
  });
});

describe('bytesToBase64', () => {
  it('matches the platform encoder, also for large buffers', () => {
    const bytes = new Uint8Array(200_000).map((_, i) => (i * 31) % 256);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});
