import { describe, expect, it, vi } from 'vitest';
import { createSpeechSources, pickVoice, type SourcesOptions } from '../src/audio/sources';

type VoiceLike = { lang: string; name: string; localService: boolean; default: boolean };
const voice = (lang: string, name = lang, localService = true): VoiceLike => ({
  lang,
  name,
  localService,
  default: false,
});

function setup(over: Partial<SourcesOptions> = {}) {
  let now = 0;
  const tts = vi.fn(async (text: string) => ({
    audio_base64: btoa(`wav:${text}`),
    encoding: 'wav',
  }));
  const onFallback = vi.fn();
  const sources = createSpeechSources({
    tts,
    lite: () => false,
    voices: async () => [voice('en-IN'), voice('hi-IN')] as unknown as SpeechSynthesisVoice[],
    toUrl: (bytes) => `blob:${new TextDecoder().decode(bytes)}`,
    phraseUrl: (key, lang) => (key === 'cart.added' ? `/audio/${lang}/${key}.wav` : null),
    onFallback,
    clock: () => now,
    ...over,
  });
  return { sources, tts, onFallback, advance: (ms: number) => (now += ms) };
}

describe('speech sources', () => {
  it('plays a pre-recorded UI phrase without calling TTS', async () => {
    const { sources, tts } = setup();
    const src = await sources.resolve({
      text: 'कार्ट में जोड़ा गया।',
      lang: 'hi',
      key: 'cart.added',
    });
    expect(src).toEqual({ kind: 'audio', url: '/audio/hi/cart.added.wav', from: 'phrase' });
    expect(tts).not.toHaveBeenCalled();
  });

  it('fetches server TTS once, then replays from the cache (rule 12)', async () => {
    const { sources, tts } = setup();
    const seg = { text: 'Battery lasts a day.', lang: 'en' as const };
    expect(await sources.resolve(seg)).toEqual({
      kind: 'audio',
      url: 'blob:wav:Battery lasts a day.',
      from: 'server',
    });
    expect(await sources.resolve(seg)).toMatchObject({ kind: 'audio', from: 'cache' });
    expect(tts).toHaveBeenCalledOnce();
  });

  it('prefetching the next sentence and then playing it costs one TTS call', async () => {
    const { sources, tts } = setup();
    const seg = { text: 'Next sentence.', lang: 'en' as const };
    sources.prefetch(seg);
    await sources.resolve(seg);
    expect(tts).toHaveBeenCalledOnce();
  });

  it('lite mode uses the device voice and never calls the server', async () => {
    const { sources, tts } = setup({ lite: () => true });
    const src = await sources.resolve({ text: 'नमस्ते', lang: 'hi' });
    expect(src).toMatchObject({ kind: 'device', lang: 'hi' });
    expect(src.kind === 'device' && src.voice.lang).toBe('hi-IN');
    expect(tts).not.toHaveBeenCalled();
  });

  it('falls back to the device voice when server TTS fails, and says so once', async () => {
    const tts = vi.fn(async () => {
      throw { error: 'busy', code: 'upstream_unavailable', retryable: true };
    });
    const { sources, onFallback } = setup({ tts });
    expect(await sources.resolve({ text: 'One.', lang: 'en' })).toMatchObject({ kind: 'device' });
    expect(await sources.resolve({ text: 'Two.', lang: 'en' })).toMatchObject({ kind: 'device' });
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it('a slow server counts as a failure (timeout)', async () => {
    const tts = vi.fn(() => new Promise<never>(() => {}));
    const { sources } = setup({ tts, timeoutMs: 20 });
    expect(await sources.resolve({ text: 'Slow.', lang: 'en' })).toMatchObject({ kind: 'device' });
  });

  it('after two failures in a row it stays on the device voice for a minute', async () => {
    let fail = true;
    const tts = vi.fn(async (text: string) => {
      if (fail) throw { code: 'upstream_unavailable' };
      return { audio_base64: btoa(text), encoding: 'wav' };
    });
    const { sources, advance } = setup({ tts });
    await sources.resolve({ text: 'A.', lang: 'en' });
    await sources.resolve({ text: 'B.', lang: 'en' });
    fail = false;
    expect(await sources.resolve({ text: 'C.', lang: 'en' })).toMatchObject({ kind: 'device' });
    expect(tts).toHaveBeenCalledTimes(2); // C did not even try the server
    advance(61_000);
    expect(await sources.resolve({ text: 'D.', lang: 'en' })).toMatchObject({
      kind: 'audio',
      from: 'server',
    });
  });

  it('a failed fetch is not cached: the next attempt tries again', async () => {
    let calls = 0;
    const tts = vi.fn(async (text: string) => {
      if (calls++ === 0) throw { code: 'upstream_unavailable' };
      return { audio_base64: btoa(text), encoding: 'wav' };
    });
    const { sources } = setup({ tts });
    await sources.resolve({ text: 'Retry me.', lang: 'en' });
    expect(await sources.resolve({ text: 'Retry me.', lang: 'en' })).toMatchObject({
      from: 'server',
    });
  });

  it('with no device voice for the language, the text is shown instead', async () => {
    const { sources } = setup({ lite: () => true }); // voices: en-IN and hi-IN only
    expect(await sources.resolve({ text: 'నమస్తే', lang: 'te' })).toEqual({ kind: 'text' });
  });

  it('clear() forgets cached audio', async () => {
    const { sources, tts } = setup();
    await sources.resolve({ text: 'Once.', lang: 'en' });
    sources.clear();
    await sources.resolve({ text: 'Once.', lang: 'en' });
    expect(tts).toHaveBeenCalledTimes(2);
  });
});

describe('pickVoice', () => {
  const v = (...langs: string[]) => langs.map((l) => voice(l)) as unknown as SpeechSynthesisVoice[];

  it('prefers the Indian variant of English', () => {
    expect(pickVoice(v('en-US', 'en-IN', 'en-GB'), 'en')?.lang).toBe('en-IN');
    expect(pickVoice(v('en-US', 'en-GB'), 'en')?.lang).toBe('en-US');
  });

  it('matches Hindi and Telugu by language, with either separator', () => {
    expect(pickVoice(v('en-IN', 'hi_IN'), 'hi')?.lang).toBe('hi_IN');
    expect(pickVoice(v('te-IN'), 'te')?.lang).toBe('te-IN');
  });

  it('prefers an on-device voice (works offline) over a network one', () => {
    const voices = [voice('hi-IN', 'cloud', false), voice('hi-IN', 'local', true)];
    expect(pickVoice(voices as unknown as SpeechSynthesisVoice[], 'hi')?.name).toBe('local');
  });

  it('never reads Hindi or Telugu with an English voice', () => {
    expect(pickVoice(v('en-IN', 'en-US'), 'hi')).toBeNull();
    expect(pickVoice(v('en-IN'), 'te')).toBeNull();
  });
});
