// Local command matcher (dysarthria fast path). STUB: exact, case-insensitive match only.
export interface MatchResult {
  candidate: string;
  score: number;
}

export function matchLocal(utterance: string, candidates: readonly string[]): MatchResult | null {
  const needle = utterance.trim().toLowerCase();
  const hit = candidates.find((c) => c.toLowerCase() === needle);
  return hit === undefined ? null : { candidate: hit, score: 1 };
}
