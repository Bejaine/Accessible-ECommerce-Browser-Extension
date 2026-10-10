import { describe, expect, it } from 'vitest';
import { resolveMode } from '../src/core/composer';
import { defaultProfile } from '../src/core/profile';

describe('composer (stub)', () => {
  it('always keeps a single-switch input as the last rung', () => {
    const mode = resolveMode(defaultProfile());
    expect(mode.input_channels.at(-1)).toBe('switch');
    expect(mode.tts_rate).toBe(1);
  });
});
