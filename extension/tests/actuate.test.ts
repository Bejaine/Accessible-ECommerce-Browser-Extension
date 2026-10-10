import { describe, expect, it } from 'vitest';
import { performAction } from '../src/actuate';

describe('actuate (stub)', () => {
  it('does not perform actions yet', async () => {
    expect((await performAction({ type: 'click', target_id: 't1' })).ok).toBe(false);
  });
});
