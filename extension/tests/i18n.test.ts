import { describe, expect, it } from 'vitest';
import { t } from '../src/i18n';
import en from '../src/i18n/en.json';
import hi from '../src/i18n/hi.json';
import te from '../src/i18n/te.json';
import ml from '../src/i18n/ml.json';

describe('i18n', () => {
  it('falls back to English, then to the key', () => {
    expect(t('overlay.title', 'xx')).toBe('Shopping assistant');
    expect(t('no.such.key')).toBe('no.such.key');
  });

  it('serves Hindi, Telugu and Malayalam strings built from en.json', () => {
    expect(t('overlay.title', 'hi')).not.toBe(t('overlay.title', 'en'));
    expect(t('overlay.title', 'te')).not.toBe(t('overlay.title', 'en'));
    expect(t('overlay.title', 'ml')).not.toBe(t('overlay.title', 'en'));
  });

  it.each([
    ['hi', hi],
    ['te', te],
    ['ml', ml],
  ])('%s has every English key and no stray ones', (_lang, table) => {
    expect(Object.keys(table).sort()).toEqual(Object.keys(en).sort());
    for (const value of Object.values(table)) expect(value.trim()).not.toBe('');
  });

  it('each language asks for itself in the language prompt', () => {
    expect(t('onboarding.choose_language', 'en')).toMatch(/English/);
    expect(t('onboarding.choose_language', 'hi')).toMatch(/हिंदी/);
    expect(t('onboarding.choose_language', 'te')).toMatch(/తెలుగు/);
    expect(t('onboarding.choose_language', 'ml')).toMatch(/മലയാളം/);
  });
});
