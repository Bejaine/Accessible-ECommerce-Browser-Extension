import { describe, expect, it } from 'vitest';
import { t } from '../src/i18n';

describe('i18n', () => {
  it('falls back to English, then to the key', () => {
    expect(t('overlay.title', 'te')).toBe('Shopping assistant');
    expect(t('no.such.key')).toBe('no.such.key');
  });
});
