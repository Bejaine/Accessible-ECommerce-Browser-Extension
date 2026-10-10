import { describe, expect, it } from 'vitest';
import { performAction } from '../src/actuate';

describe('actuate (stub)', () => {
  it('does not perform actions yet', async () => {
    const action = {
      schema_version: '1.0',
      id: 'a1',
      type: 'click',
      target_id: 't1',
      value: null,
      expected_effect: { kind: 'none', detail: null },
    } as const;
    expect((await performAction(action)).ok).toBe(false);
  });
});
