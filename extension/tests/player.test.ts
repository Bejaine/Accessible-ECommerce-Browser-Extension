import { describe, expect, it } from 'vitest';
import { createPlayer } from '../src/audio/player';

describe('player (stub)', () => {
  it('queues sentences and clears on stop', () => {
    const p = createPlayer();
    p.enqueue(['One.', 'Two.']);
    expect(p.queue).toEqual(['One.', 'Two.']);
    p.stop();
    expect(p.queue).toEqual([]);
  });
});
