// Continuity across page loads. A full navigation ends the content script, but the backend keeps
// a shopping session (order tasks in progress, products seen earlier) per session_id, and an
// order task resumes on the next page with a "Continue" turn (docs/backend-api.md §4, §6).
// The background script holds both, so every page of every site shares them:
// - one session id per browser session, renewed after 30 idle minutes (the backend forgets
//   sessions after that anyway);
// - per tab, a short-lived "continue the order task" marker, set before a workflow step that may
//   navigate and taken by the next page.
// Nothing here is personal: a random id, a tab id and timestamps, in extension-only storage.

export const SESSION_MESSAGE = 'asl-session';
export const CONTINUE_MESSAGE = 'asl-continue';

export const SESSION_IDLE_MS = 30 * 60_000;
/** A page that loads later than this after the step was taken does not continue the task. */
export const CONTINUE_MAX_AGE_MS = 60_000;

export type ContinuityMessage =
  { type: typeof SESSION_MESSAGE } | { type: typeof CONTINUE_MESSAGE; op: 'mark' | 'clear' };

export interface SessionReply {
  session_id: string;
  /** True when the previous page of this tab asked the order task to continue here. */
  continue_task: boolean;
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

  async function takeContinue(tabId: number | undefined): Promise<boolean> {
    if (tabId === undefined) return false;
    const key = continueKey(tabId);
    const at = (await store.get(key))[key];
    if (at === undefined) return false;
    await store.remove(key);
    return typeof at === 'number' && now() - at <= CONTINUE_MAX_AGE_MS;
  }

  return {
    async handle(message: ContinuityMessage, tabId: number | undefined): Promise<unknown> {
      if (message.type === SESSION_MESSAGE) {
        const reply: SessionReply = {
          session_id: await sessionId(),
          continue_task: await takeContinue(tabId),
        };
        return reply;
      }
      if (tabId === undefined) return false;
      if (message.op === 'mark') await store.set({ [continueKey(tabId)]: now() });
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
  /** Before a workflow step that may navigate: the next page of this tab continues the task. */
  mark(): Promise<void>;
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
    mark: () => quiet(send({ type: CONTINUE_MESSAGE, op: 'mark' })),
    clear: () => quiet(send({ type: CONTINUE_MESSAGE, op: 'clear' })),
  };
}

/** Content side, at page load: the shared session id, and whether to continue an order task. */
export async function requestSession(send: Send): Promise<SessionReply> {
  try {
    const reply = (await send({ type: SESSION_MESSAGE })) as SessionReply | undefined;
    if (reply?.session_id) return reply;
  } catch {
    // Background unavailable: this page gets its own session (the old behaviour).
  }
  return { session_id: crypto.randomUUID(), continue_task: false };
}
