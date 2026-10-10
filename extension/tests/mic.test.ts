import { describe, expect, it, vi } from 'vitest';
import {
  createMic,
  MicError,
  toAsrRequest,
  type AudioSource,
  type ListenOptions,
  type Mic,
} from '../src/audio/mic';
import { chunks, concat, hiss, readWav, tone } from './audio-helpers';

const RATE = 48000; // what most laptop and phone mics deliver

/** A microphone we control: tests push audio into whatever listen() started. */
function fakeMic() {
  let onChunk: ((c: Float32Array) => void) | null = null;
  const source: AudioSource = {
    sampleRate: RATE,
    start: (cb) => {
      onChunk = cb;
    },
    stop: vi.fn(() => {
      onChunk = null;
    }),
  };
  const open = vi.fn(async () => source);
  return {
    source,
    open,
    mic: createMic({ openSource: open }),
    /** Push audio as ScriptProcessor-sized chunks; returns false once the mic was closed. */
    play(audio: Float32Array) {
      for (const c of chunks(audio)) {
        if (!onChunk) return false;
        onChunk(c);
      }
      return onChunk !== null;
    },
  };
}

/** Start listening and wait until the source is open. Wrapped so awaiting this doesn't
 *  wait for the utterance itself. */
async function begin(mic: Mic, opts: ListenOptions = {}) {
  const done = mic.listen(opts);
  await new Promise((r) => setTimeout(r, 0));
  return { done };
}

const SAY_ONE_SECOND = concat(hiss(0.5, RATE), tone(1, RATE));

describe('mic', () => {
  it('records one utterance as a 16 kHz WAV and closes the mic', async () => {
    const f = fakeMic();
    const { done } = await begin(f.mic);
    f.play(concat(SAY_ONE_SECOND, hiss(2, RATE)));
    const u = await done;
    expect(u.reason).toBe('silence');
    const wav = readWav(u.wav!);
    expect(wav).toMatchObject({ sampleRate: 16000, channels: 1, bits: 16 });
    expect(wav.seconds).toBeGreaterThan(1.4);
    expect(wav.seconds).toBeLessThan(1.8);
    expect(u.durationMs).toBe(Math.round(wav.seconds * 1000));
    expect(u.audioBase64).toBe(Buffer.from(u.wav!).toString('base64'));
    expect(u.micLevel).toBeGreaterThan(0.7);
    expect(f.source.stop).toHaveBeenCalledOnce();
    expect(f.mic.listening).toBe(false);
  });

  it('keeps listening through a 2 s pause in speech mode', async () => {
    const f = fakeMic();
    const { done } = await begin(f.mic, { mode: 'speech' });
    expect(f.play(concat(SAY_ONE_SECOND, hiss(2, RATE)))).toBe(true); // still open
    f.play(concat(tone(0.5, RATE), hiss(3, RATE)));
    const u = await done;
    expect(u.reason).toBe('silence');
    expect(readWav(u.wav!).seconds).toBeGreaterThan(3.5); // both parts of the sentence
  });

  it('reports the level while listening, about 10 times a second', async () => {
    const f = fakeMic();
    const levels: number[] = [];
    const { done } = await begin(f.mic, { onLevel: (l) => levels.push(l) });
    f.play(concat(SAY_ONE_SECOND, hiss(2, RATE)));
    await done;
    expect(levels.length).toBeGreaterThan(20);
    expect(levels.length).toBeLessThan(40);
    expect(Math.max(...levels)).toBeGreaterThan(0.7);
  });

  it('tells the caller when speech starts', async () => {
    const f = fakeMic();
    const onSpeechStart = vi.fn();
    const { done } = await begin(f.mic, { onSpeechStart });
    f.play(hiss(0.5, RATE));
    expect(onSpeechStart).not.toHaveBeenCalled();
    f.play(concat(tone(1, RATE), hiss(2, RATE)));
    await done;
    expect(onSpeechStart).toHaveBeenCalledOnce();
  });

  it('mute (secure zone) closes the mic at once and throws away the audio', async () => {
    const f = fakeMic();
    const { done } = await begin(f.mic);
    f.play(SAY_ONE_SECOND);
    f.mic.mute();
    expect(await done).toMatchObject({ reason: 'muted', wav: null, audioBase64: null });
    expect(f.source.stop).toHaveBeenCalledOnce();
    expect(f.play(tone(0.1, RATE))).toBe(false);
    expect(f.mic.muted).toBe(true);
  });

  it('refuses to listen while muted, and listens again after unmute', async () => {
    const f = fakeMic();
    f.mic.mute();
    await expect(f.mic.listen()).rejects.toMatchObject({ code: 'secure_zone' });
    expect(f.open).not.toHaveBeenCalled();
    f.mic.unmute();
    const { done } = await begin(f.mic);
    f.play(concat(SAY_ONE_SECOND, hiss(2, RATE)));
    expect((await done).reason).toBe('silence');
  });

  it('mute while the mic is still opening never starts recording', async () => {
    const f = fakeMic();
    const done = f.mic.listen();
    f.mic.mute(); // before openSource resolved
    expect(await done).toMatchObject({ reason: 'muted', wav: null });
    expect(f.source.stop).toHaveBeenCalledOnce();
  });

  it('stop() ends early but keeps what was said', async () => {
    const f = fakeMic();
    const { done } = await begin(f.mic);
    f.play(SAY_ONE_SECOND);
    f.mic.stop();
    const u = await done;
    expect(u.reason).toBe('stopped');
    expect(readWav(u.wav!).seconds).toBeGreaterThan(1);
  });

  it('stop() before any speech returns no audio', async () => {
    const f = fakeMic();
    const { done } = await begin(f.mic);
    f.play(hiss(0.5, RATE));
    f.mic.stop();
    expect(await done).toMatchObject({ reason: 'no_speech', wav: null });
  });

  it('gives up after 15 s of nobody speaking, with a near-zero level', async () => {
    const f = fakeMic();
    const { done } = await begin(f.mic);
    f.play(hiss(16, RATE));
    const u = await done;
    expect(u).toMatchObject({ reason: 'no_speech', wav: null });
    expect(u.micLevel).toBeLessThan(0.15);
  });

  it('stays under the 20 s ASR limit', async () => {
    const f = fakeMic();
    const { done } = await begin(f.mic);
    f.play(concat(hiss(0.5, RATE), tone(25, RATE)));
    const u = await done;
    expect(u.reason).toBe('max_length');
    expect(readWav(u.wav!).seconds).toBeLessThanOrEqual(19);
  });

  it('returns the same promise if listen() is called twice', async () => {
    const f = fakeMic();
    const a = f.mic.listen();
    expect(f.mic.listen()).toBe(a);
    await new Promise((r) => setTimeout(r, 0));
    f.mic.stop();
    await a;
    expect(f.open).toHaveBeenCalledOnce();
  });

  it.each([
    ['NotAllowedError', 'permission_denied'],
    ['SecurityError', 'permission_denied'],
    ['NotFoundError', 'no_microphone'],
    ['NotReadableError', 'unavailable'],
  ])('maps %s to %s', async (name, code) => {
    const mic = createMic({
      openSource: async () => {
        throw new DOMException('no', name);
      },
    });
    const err = await mic.listen().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MicError);
    expect(err).toMatchObject({ code });
    expect(mic.listening).toBe(false);
  });
});

describe('toAsrRequest', () => {
  it('builds the /speech/asr body, with our mic level for asr_meta', () => {
    const utterance = {
      reason: 'silence' as const,
      wav: new Uint8Array([1, 2, 3]),
      audioBase64: 'AQID',
      durationMs: 1200,
      micLevel: 0.42,
    };
    expect(toAsrRequest(utterance, 'hi')).toEqual({
      schema_version: '1.0',
      lang: 'hi',
      audio_base64: 'AQID',
      encoding: 'wav',
      sample_rate: 16000,
      mic_level: 0.42,
    });
  });

  it('refuses an utterance with no audio', () => {
    const empty = {
      reason: 'no_speech' as const,
      wav: null,
      audioBase64: null,
      durationMs: 0,
      micLevel: 0,
    };
    expect(() => toAsrRequest(empty, 'en')).toThrow(MicError);
  });
});

describe('mic messages', () => {
  it('has a calm, spoken message for every mic error code', async () => {
    const { t } = await import('../src/i18n');
    const codes = ['permission_denied', 'no_microphone', 'unavailable', 'secure_zone', 'no_audio'];
    for (const code of codes) expect(t(`mic.${code}`)).not.toBe(`mic.${code}`);
  });
});
