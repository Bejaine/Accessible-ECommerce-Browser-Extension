// Condition inference, on device only (rule 8): passive signal collectors, decaying 0-1 scores
// per condition, and the suggest-then-switch flow (rule 5).
export { attachCollectors, TUNING } from './collectors';
export {
  createScoreEngine,
  INFERRED_CONDITIONS,
  MIN_GROUPS,
  SIGNALS,
  SUGGEST_THRESHOLD,
} from './scores';
export type { ConditionScore, InferredCondition, ScoreEngine, Scores, SignalKind } from './scores';
export { createSuggester, modeName } from './suggest';
export type { QuestionAnswer, Suggester, SuggestionState } from './suggest';
