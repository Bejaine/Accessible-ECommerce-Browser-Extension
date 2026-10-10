// Input fallback: two failed attempts in a row -> offer the phrase board and drop one rung of the
// input ladder. Never ask the user to repeat a third time (docs/conditions.md, unclear speech).
// A success resets the count but keeps the current rung; the user can move back up explicitly.
import type { InputRung, ResolvedMode } from '@shared/index';
import { nextRung } from './composer';

export const FAILURES_BEFORE_FALLBACK = 2;

export interface FallbackStep {
  rung: InputRung;
  /** Show the phrase board now instead of asking again. */
  offerPhrases: boolean;
}

export interface InputFallback {
  readonly rung: InputRung;
  recordFailure(): FallbackStep;
  recordSuccess(): void;
  /** Explicit user choice, e.g. "use voice again". */
  setRung(rung: InputRung): void;
}

export function createInputFallback(mode: ResolvedMode): InputFallback {
  let rung = mode.input_rung;
  let failures = 0;
  return {
    get rung() {
      return rung;
    },
    recordFailure() {
      failures++;
      if (failures < FAILURES_BEFORE_FALLBACK) return { rung, offerPhrases: false };
      failures = 0;
      rung = nextRung(mode, rung);
      return { rung, offerPhrases: true };
    },
    recordSuccess() {
      failures = 0;
    },
    setRung(next) {
      rung = next;
      failures = 0;
    },
  };
}
