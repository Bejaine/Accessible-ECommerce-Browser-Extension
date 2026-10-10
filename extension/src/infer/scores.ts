// Condition scores from on-device signals (docs/conditions.md, "Inference"). Nothing here leaves
// the device (rule 8).
//
// Each signal kind adds evidence to one condition. Kinds that measure the same underlying thing
// share a group (e.g. clicks and focus moves without a pointer both mean "keyboard use"). A
// group's evidence decays over time and is capped, and a condition's score combines its groups:
//   score = 1 - Π(1 - group_value)
// Caps make the two-signal rule structural: one group can reach at most 0.5 (< 0.7), so a
// suggestion needs two independent groups; ageing groups cap at 0.35, so ageing needs three
// ("several together"). Colour vision is never inferred, so it has no signals.

export type InferredCondition = 'visual' | 'speech' | 'motor' | 'ageing';
export const INFERRED_CONDITIONS: readonly InferredCondition[] = [
  'visual',
  'speech',
  'motor',
  'ageing',
];

export const SUGGEST_THRESHOLD = 0.7;
export const MIN_GROUPS: Record<InferredCondition, number> = {
  visual: 2,
  speech: 2,
  motor: 2,
  ageing: 3,
};

interface SignalDef {
  condition: InferredCondition;
  /** Evidence added per occurrence (before the cap). */
  weight: number;
  /** Independence group; defaults to the kind itself. */
  group?: string;
}

const CAP: Record<InferredCondition, number> = {
  visual: 0.5,
  speech: 0.5,
  motor: 0.5,
  ageing: 0.35,
};

export const SIGNALS = {
  // Visual. Keyboard use is one group: it also fits motor, so alone it only triggers a question.
  click_without_pointer: { condition: 'visual', weight: 0.06, group: 'keyboard' },
  focus_without_pointer: { condition: 'visual', weight: 0.03, group: 'keyboard' },
  contrast_setting: { condition: 'visual', weight: 0.5 },
  pinch_zoom: { condition: 'visual', weight: 0.25 },
  // Motor.
  low_path_efficiency: { condition: 'motor', weight: 0.12 },
  direction_changes: { condition: 'motor', weight: 0.1 },
  repeat_click: { condition: 'motor', weight: 0.15 },
  near_miss: { condition: 'motor', weight: 0.15 },
  long_press: { condition: 'motor', weight: 0.1 },
  backspace_rate: { condition: 'motor', weight: 0.1 },
  // Speech (reported by the voice pipeline, never from silence with a near-zero mic level).
  unheard_speech: { condition: 'speech', weight: 0.2 },
  low_confidence: { condition: 'speech', weight: 0.15 },
  speech_retry: { condition: 'speech', weight: 0.15 },
  // Ageing: only meaningful together.
  hesitation: { condition: 'ageing', weight: 0.2 },
  long_hover: { condition: 'ageing', weight: 0.1 },
  slow_scroll: { condition: 'ageing', weight: 0.08 },
  help_use: { condition: 'ageing', weight: 0.15 },
  large_text: { condition: 'ageing', weight: 0.35 },
} satisfies Record<string, SignalDef>;

export type SignalKind = keyof typeof SIGNALS;

export interface ConditionScore {
  score: number;
  /** Decayed value per independence group (only groups with evidence). */
  groups: Record<string, number>;
  /** Groups strong enough to count as independent evidence. */
  groupCount: number;
  ready: boolean;
}

export type Scores = Record<InferredCondition, ConditionScore>;

export interface LoggedSignal {
  kind: SignalKind;
  at: number;
}

export interface ScoreEngine {
  add(kind: SignalKind, strength?: number): void;
  scores(): Scores;
  /** Recent signals, for calibration recordings (stays on the device). */
  readonly log: readonly LoggedSignal[];
  reset(): void;
}

/** A group counts as evidence once it holds at least this much. */
const GROUP_MIN = 0.1;
const LOG_SIZE = 500;

export function createScoreEngine(
  opts: { now?: () => number; halfLifeMs?: number } = {},
): ScoreEngine {
  const now = opts.now ?? (() => performance.now());
  const halfLife = opts.halfLifeMs ?? 180_000;
  const groups = new Map<string, { condition: InferredCondition; value: number; at: number }>();
  let log: LoggedSignal[] = [];

  const decayed = (value: number, at: number, t: number) => value * 0.5 ** ((t - at) / halfLife);

  return {
    add(kind, strength = 1) {
      const def: SignalDef = SIGNALS[kind];
      const key = `${def.condition}:${def.group ?? kind}`;
      const t = now();
      const prev = groups.get(key);
      const base = prev ? decayed(prev.value, prev.at, t) : 0;
      const value = Math.min(CAP[def.condition], base + def.weight * strength);
      groups.set(key, { condition: def.condition, value, at: t });
      log.push({ kind, at: t });
      if (log.length > LOG_SIZE) log = log.slice(-LOG_SIZE);
    },
    scores() {
      const t = now();
      const out = Object.fromEntries(
        INFERRED_CONDITIONS.map((c) => [c, { score: 0, groups: {}, groupCount: 0, ready: false }]),
      ) as Scores;
      for (const [key, g] of groups) {
        const value = decayed(g.value, g.at, t);
        if (value < 0.001) continue;
        out[g.condition].groups[key.split(':')[1]!] = value;
      }
      for (const c of INFERRED_CONDITIONS) {
        const values = Object.values(out[c].groups);
        out[c].score = 1 - values.reduce((p, v) => p * (1 - v), 1);
        out[c].groupCount = values.filter((v) => v >= GROUP_MIN).length;
        out[c].ready = out[c].score >= SUGGEST_THRESHOLD && out[c].groupCount >= MIN_GROUPS[c];
      }
      return out;
    },
    get log() {
      return log;
    },
    reset() {
      groups.clear();
      log = [];
    },
  };
}
