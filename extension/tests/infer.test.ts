import { describe, expect, it } from 'vitest';
import { emptyScores } from '../src/infer';

describe('infer (stub)', () => {
  it('starts every score at zero', () => {
    expect(Object.values(emptyScores()).every((s) => s === 0)).toBe(true);
  });
});
