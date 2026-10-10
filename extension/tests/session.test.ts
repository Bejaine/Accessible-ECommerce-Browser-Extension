import { describe, expect, it } from 'vitest';
import { MAX_HISTORY, createSession, pushHistory } from '../src/core/session';

describe('session', () => {
  it('keeps only the last 6 turns', () => {
    const s = createSession('s1');
    for (let i = 0; i < 10; i++) pushHistory(s, { role: 'user', text: String(i) });
    expect(s.history).toHaveLength(MAX_HISTORY);
    expect(s.history[0]?.text).toBe('4');
  });
});
