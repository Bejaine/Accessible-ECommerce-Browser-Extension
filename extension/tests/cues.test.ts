import { describe, expect, it } from 'vitest';
import { CUE_KEYS, cueUrl } from '../src/ui/cues';

describe('listening cues', () => {
  it('the cue keys resolve to the chimes, inlined so shop pages can play them', () => {
    // Inline data URLs: a page can't load extension files that aren't web-accessible.
    expect(cueUrl(CUE_KEYS.listen)).toMatch(/^data:audio\/(wav|x-wav);base64,UklGR/);
    expect(cueUrl(CUE_KEYS.done)).toMatch(/^data:audio\/(wav|x-wav);base64,UklGR/);
    expect(cueUrl(CUE_KEYS.listen)).not.toBe(cueUrl(CUE_KEYS.done));
  });

  it('other keys are not cues', () => {
    expect(cueUrl('mic.listening')).toBeNull();
  });
});
