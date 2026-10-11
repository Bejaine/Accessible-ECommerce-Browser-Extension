// Background side of continuity: one session across pages, per-tab "continue the order task".
import { describe, expect, it } from 'vitest';
import {
  CONTINUE_MESSAGE,
  createContinuity,
  memoryStore,
  requestSession,
  SESSION_MESSAGE,
  type SessionReply,
} from '../src/core/continuity';

function setup() {
  let now = 1_000_000;
  let ids = 0;
  const c = createContinuity(
    memoryStore(),
    () => now,
    () => `id-${++ids}`,
  );
  const session = (tab?: number) =>
    c.handle({ type: SESSION_MESSAGE }, tab) as Promise<SessionReply>;
  const mark = (tab?: number) => c.handle({ type: CONTINUE_MESSAGE, op: 'mark' }, tab);
  const clear = (tab?: number) => c.handle({ type: CONTINUE_MESSAGE, op: 'clear' }, tab);
  return { session, mark, clear, advance: (ms: number) => void (now += ms) };
}

describe('continuity', () => {
  it('every page and tab shares one session id until 30 idle minutes', async () => {
    const { session, advance } = setup();
    expect((await session(1)).session_id).toBe('id-1');
    advance(29 * 60_000);
    expect((await session(2)).session_id).toBe('id-1'); // using it keeps it alive
    advance(29 * 60_000);
    expect((await session(1)).session_id).toBe('id-1');
    advance(31 * 60_000);
    expect((await session(1)).session_id).toBe('id-2');
  });

  it('the continue marker is per tab, taken once, and expires after a minute', async () => {
    const { session, mark, clear, advance } = setup();
    await mark(7);
    expect((await session(8)).continue_task).toBe(false); // another tab
    expect((await session(7)).continue_task).toBe(true);
    expect((await session(7)).continue_task).toBe(false); // taken
    await mark(7);
    await clear(7);
    expect((await session(7)).continue_task).toBe(false);
    await mark(7);
    advance(61_000);
    expect((await session(7)).continue_task).toBe(false);
  });

  it('a page without a background still gets a session of its own', async () => {
    const reply = await requestSession(() => Promise.reject(new Error('no receiver')));
    expect(reply.continue_task).toBe(false);
    expect(reply.session_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
