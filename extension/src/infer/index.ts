// Condition inference: passive signal collectors and decaying 0-1 scores (on device only).
// STUB: no collectors yet.
export type InferredCondition = 'visual' | 'speech' | 'motor' | 'ageing';

export type Scores = Record<InferredCondition, number>;

export function emptyScores(): Scores {
  return { visual: 0, speech: 0, motor: 0, ageing: 0 };
}
