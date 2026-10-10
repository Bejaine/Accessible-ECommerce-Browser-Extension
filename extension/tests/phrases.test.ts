import { describe, expect, it } from 'vitest';
import { phraseAudioUrl, phraseAudioUrlFrom } from '../src/audio/phrases';
import { t } from '../src/i18n';
import en from '../src/i18n/en.json';
import manifest from '../src/i18n/audio/manifest.json';
import prerecord from '../src/i18n/prerecord.json';

describe('pre-recorded phrase audio', () => {
  it('has a recording of every listed phrase in every language', () => {
    for (const lang of ['en', 'hi', 'te'])
      for (const key of prerecord) expect(phraseAudioUrl(key, lang), `${lang} ${key}`).toBeTruthy();
  });

  it('every recording was made from the current text', () => {
    for (const [lang, entries] of Object.entries(
      manifest as Record<string, Record<string, string>>,
    ))
      for (const [key, text] of Object.entries(entries))
        expect(text, `${lang} ${key}`).toBe(t(key, lang));
  });

  it('never plays a recording of different text: the caller falls back to live TTS', () => {
    const files = { 'hi/cart.added': '/hi/cart.added.wav' };
    const recorded = { hi: { 'cart.added': 'पुराना वाक्य' } };
    expect(phraseAudioUrlFrom(files, recorded, 'cart.added', 'hi', 'नया वाक्य')).toBeNull();
    expect(phraseAudioUrlFrom(files, recorded, 'cart.added', 'hi', 'पुराना वाक्य')).toBe(
      '/hi/cart.added.wav',
    );
  });

  it('lists only real UI strings, and keeps long messages out (they are spoken live)', () => {
    for (const key of prerecord) expect(Object.keys(en)).toContain(key);
    expect(prerecord).not.toContain('mic.permission_denied');
    expect(phraseAudioUrl('mic.permission_denied', 'hi')).toBeNull();
  });

  it('returns null for an unknown key or language', () => {
    expect(phraseAudioUrl('no.such.key', 'hi')).toBeNull();
    expect(phraseAudioUrl('cart.added', 'ml')).toBeNull();
  });
});
