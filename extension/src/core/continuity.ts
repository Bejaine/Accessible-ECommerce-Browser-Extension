// Continuity across page loads. A full navigation ends the content script, but the backend keeps
// a shopping session (order tasks in progress, products seen earlier) per session_id, and an
// order task resumes on the next page with a "Continue" turn (docs/backend-api.md §4, §6).
// The background script holds both, so every page of every site shares them:
// - one session id per browser session, renewed after 30 idle minutes (the backend forgets
//   sessions after that anyway);
// - per tab, a short-lived marker for what the next page should do, set before an action that
//   may navigate and taken by the next page: "continue" an order task, or "read_results" after a
//   search (the next page asks for its results to be read: a chip, no LLM call).
// Nothing here is personal: a random id, a tab id and timestamps, in extension-only storage.

export const SESSION_MESSAGE = 'asl-session';
export const CONTINUE_MESSAGE = 'asl-continue';

export const SESSION_IDLE_MS = 30 * 60_000;
/** A page that loads later than this after the step was taken does not continue the task. */
export const CONTINUE_MAX_AGE_MS = 60_000;

/** What the next page of a tab should do on load. */
export type NextStep = 'continue' | 'read_results';

export type ContinuityMessage =
  | { type: typeof SESSION_MESSAGE }
  | { type: typeof CONTINUE_MESSAGE; op: 'mark' | 'clear'; step?: NextStep };

export interface SessionReply {
  session_id: string;
  /** True when the previous page of this tab asked the order task to continue here. */
  continue_task: boolean;
  /** What the previous page of this tab asked this page to do (null: nothing). */
  next_step: NextStep | null;
}

/** The subset of browser.storage.session/local used here (injectable for tests). */
export interface KeyValueStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/** In-memory fallback where storage.session doesn't exist (older Firefox). */
export function memoryStore(): KeyValueStore {
  const data = new Map<string, unknown>();
  return {
    get: async (key) => (data.has(key) ? { [key]: data.get(key) } : {}),
    set: async (items) => void Object.entries(items).forEach(([k, v]) => data.set(k, v)),
    remove: async (key) => void data.delete(key),
  };
}

const SESSION_KEY = 'asl-session';
const continueKey = (tabId: number): string => `asl-continue-${tabId}`;

/** Background side: answers SESSION_MESSAGE / CONTINUE_MESSAGE for the sending tab. */
export function createContinuity(
  store: KeyValueStore,
  now: () => number = Date.now,
  newId: () => string = () => crypto.randomUUID(),
) {
  async function sessionId(): Promise<string> {
    const saved = (await store.get(SESSION_KEY))[SESSION_KEY] as
      { id: string; used_at: number } | undefined;
    const id = saved && now() - saved.used_at < SESSION_IDLE_MS ? saved.id : newId();
    await store.set({ [SESSION_KEY]: { id, used_at: now() } });
    return id;
  }

  async function takeNext(tabId: number | undefined): Promise<NextStep | null> {
    if (tabId === undefined) return null;
    const key = continueKey(tabId);
    const saved = (await store.get(key))[key];
    if (saved === undefined) return null;
    await store.remove(key);
    // A bare timestamp is an order-task marker (as stored before marker kinds existed).
    const { at, step } =
      typeof saved === 'number'
        ? { at: saved, step: 'continue' as const }
        : (saved as { at?: unknown; step?: unknown });
    if (typeof at !== 'number' || now() - at > CONTINUE_MAX_AGE_MS) return null;
    return step === 'read_results' ? 'read_results' : 'continue';
  }

  return {
    async handle(message: ContinuityMessage, tabId: number | undefined): Promise<unknown> {
      if (message.type === SESSION_MESSAGE) {
        const next = await takeNext(tabId);
        const reply: SessionReply = {
          session_id: await sessionId(),
          continue_task: next === 'continue',
          next_step: next,
        };
        return reply;
      }
      if (tabId === undefined) return false;
      if (message.op === 'mark')
        await store.set({ [continueKey(tabId)]: { at: now(), step: message.step ?? 'continue' } });
      else await store.remove(continueKey(tabId));
      return true;
    },
  };
}

export function isContinuityMessage(msg: unknown): msg is ContinuityMessage {
  const type = (msg as { type?: unknown } | null)?.type;
  return type === SESSION_MESSAGE || type === CONTINUE_MESSAGE;
}

/** Content side: what the turn pipeline needs to keep an order task going across pages. */
export interface TaskContinuity {
  /**
   * Before an action that may navigate: what the next page of this tab does on load ("continue"
   * an order task, the default; or "read_results" after a search).
   */
  mark(step?: NextStep): Promise<void>;
  /** The task ended, or this page continues it itself. */
  clear(): Promise<void>;
}

type Send = (message: ContinuityMessage) => Promise<unknown>;

export function createTaskContinuity(send: Send): TaskContinuity {
  const quiet = (p: Promise<unknown>): Promise<void> =>
    p.then(
      () => undefined,
      () => undefined,
    );
  return {
    mark: (step = 'continue') => quiet(send({ type: CONTINUE_MESSAGE, op: 'mark', step })),
    clear: () => quiet(send({ type: CONTINUE_MESSAGE, op: 'clear' })),
  };
}

/** Content side, at page load: the shared session id, and whether to continue an order task. */
export async function requestSession(send: Send): Promise<SessionReply> {
  try {
    const reply = (await send({ type: SESSION_MESSAGE })) as Partial<SessionReply> | undefined;
    if (reply?.session_id) {
      const next = reply.next_step ?? (reply.continue_task ? 'continue' : null);
      return { session_id: reply.session_id, continue_task: next === 'continue', next_step: next };
    }
  } catch {
    // Background unavailable: this page gets its own session (the old behaviour).
  }
  return { session_id: crypto.randomUUID(), continue_task: false, next_step: null };
}
