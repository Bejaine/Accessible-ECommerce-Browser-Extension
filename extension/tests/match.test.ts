import { describe, expect, it } from 'vitest';
import { matchLocal } from '../src/match';

describe('match (stub)', () => {
  it('matches exactly, ignoring case, and returns null otherwise', () => {
    expect(matchLocal(' Pause ', ['pause', 'stop'])).toEqual({ candidate: 'pause', score: 1 });
    expect(matchLocal('buy it', ['pause'])).toBeNull();
  });
});
