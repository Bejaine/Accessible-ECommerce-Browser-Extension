// Per-tab session state. History is capped at the last 6 turns (TurnRequest contract).
import type { TurnRequest } from '@shared/index';

export type HistoryTurn = TurnRequest['history'][number];

export const MAX_HISTORY = 6;

export interface Session {
  id: string;
  history: HistoryTurn[];
}

export function createSession(id: string = crypto.randomUUID()): Session {
  return { id, history: [] };
}

export function pushHistory(session: Session, turn: HistoryTurn): void {
  session.history.push(turn);
  if (session.history.length > MAX_HISTORY)
    session.history.splice(0, session.history.length - MAX_HISTORY);
}
