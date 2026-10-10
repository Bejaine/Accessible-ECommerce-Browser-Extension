// Replays a recorded session's signals through the real score engine, to calibrate weights and
// measure the false-suggestion rate (docs/conditions.md, "Calibration and evaluation").
// Sessions are recorded on a device with `__asl.recordSession()` / `__asl.saveSession()` in a dev
// build; nothing here leaves the machine.
import {
  createScoreEngine,
  INFERRED_CONDITIONS,
  type InferredCondition,
  type SignalKind,
} from './scores';

export type SessionLabel = 'normal' | InferredCondition;

export interface RecordedSession {
  /** What the person was doing: normal use, or simulating one condition. */
  label: SessionLabel;
  /** Who recorded it (initials) and when, for the report. */
  recordedBy?: string;
  recordedAt?: string;
  durationMs: number;
  /** Milliseconds from the start of the recording. */
  signals: { kind: SignalKind; at: number }[];
}

export interface ReplayResult {
  label: SessionLabel;
  /** First condition that became ready to suggest, and when (ms from start); null if none. */
  suggested: InferredCondition | null;
  at: number | null;
  /** Highest score each condition reached. */
  peak: Record<InferredCondition, number>;
}

/** Check the scores this often while replaying (the app checks every 2 s). */
export const CHECK_EVERY_MS = 2000;

export function replaySession(
  session: RecordedSession,
  opts: { halfLifeMs?: number } = {},
): ReplayResult {
  let now = 0;
  const engine = createScoreEngine({ now: () => now, halfLifeMs: opts.halfLifeMs });
  const signals = [...session.signals].sort((a, b) => a.at - b.at);
  const peak = Object.fromEntries(INFERRED_CONDITIONS.map((c) => [c, 0])) as Record<
    InferredCondition,
    number
  >;
  let next = 0;
  for (let t = 0; t <= session.durationMs; t += CHECK_EVERY_MS) {
    while (next < signals.length && signals[next]!.at <= t) {
      now = signals[next]!.at;
      engine.add(signals[next]!.kind);
      next++;
    }
    now = t;
    const scores = engine.scores();
    for (const c of INFERRED_CONDITIONS) peak[c] = Math.max(peak[c], scores[c].score);
    const ready = INFERRED_CONDITIONS.filter((c) => scores[c].ready).sort(
      (a, b) => scores[b].score - scores[a].score,
    )[0];
    if (ready) return { label: session.label, suggested: ready, at: t, peak };
  }
  return { label: session.label, suggested: null, at: null, peak };
}

export interface EvaluationSummary {
  normalSessions: number;
  /** Normal sessions in which anything would have been suggested (should be 0). */
  falseSuggestions: number;
  falseSuggestionRate: number | null;
  /** Per simulated condition: sessions, and how many got the right suggestion. */
  detection: Record<InferredCondition, { sessions: number; correct: number }>;
}

export function summarise(results: ReplayResult[]): EvaluationSummary {
  const normal = results.filter((r) => r.label === 'normal');
  const falseSuggestions = normal.filter((r) => r.suggested !== null).length;
  const detection = Object.fromEntries(
    INFERRED_CONDITIONS.map((c) => {
      const sims = results.filter((r) => r.label === c);
      return [c, { sessions: sims.length, correct: sims.filter((r) => r.suggested === c).length }];
    }),
  ) as EvaluationSummary['detection'];
  return {
    normalSessions: normal.length,
    falseSuggestions,
    falseSuggestionRate: normal.length > 0 ? falseSuggestions / normal.length : null,
    detection,
  };
}
