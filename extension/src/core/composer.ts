// Multi-condition composer: resolves any combination of active conditions (plus prefs) into one
// ResolvedMode. Rules, not per-combination branches (docs/conditions.md, "Multiple conditions"):
//
// - Pacing takes the most restrictive value over active conditions: longest scan interval, fewest
//   options, shortest summaries. Speech rate is different: a condition only sets a slower
//   *starting* rate when it is turned on (activateCondition), and the user can change it
//   afterwards ("slower" / "faster", or the speed buttons).
// - Input: a fixed fallback ladder voice -> keyboard -> phrase chips -> single switch. Each
//   condition marks rungs it makes unreliable; the mode starts at the first reliable rung and
//   falls back through the reliable rungs below it. The switch is never dropped, so nobody is
//   locked out.
// - Output: audio when visual is active; large text for ageing or low vision (text_scale > 1);
//   otherwise audio plus the normal visual overlay.
//
// Only `active` flags are used: inferred scores never change the mode until the user accepts a
// suggestion (rule 5). Colour vision changes labelling, not the mode.
import type { InputRung, Profile, ResolvedMode } from '@shared/index';

export const LADDER: readonly InputRung[] = ['voice', 'keyboard', 'phrase', 'switch'];

type Condition = 'visual' | 'speech' | 'motor' | 'ageing';

interface Rule {
  /** Rungs this condition makes unreliable as a starting point. */
  unreliable?: InputRung[];
  scanIntervalMs?: number;
  maxOptions?: number;
  shortSummaries?: boolean;
}

export const BASE = { scanIntervalMs: 1500, maxOptions: 5 } as const;

export const RULES: Record<Condition, Rule> = {
  // Auditory scanning speaks every highlighted item, so items need longer to read out.
  visual: { scanIntervalMs: 2500 },
  // Unclear speech: voice is still listened to, but not relied on as the main input.
  speech: { unreliable: ['voice'] },
  // Typing and precise taps are hard; full voice control and switch scanning are not.
  motor: { unreliable: ['keyboard'], scanIntervalMs: 2000 },
  ageing: { scanIntervalMs: 2500, maxOptions: 3, shortSummaries: true },
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function activeConditions(profile: Profile): Condition[] {
  return (Object.keys(RULES) as Condition[]).filter((c) => profile.conditions[c].active);
}

export function resolveMode(profile: Profile): ResolvedMode {
  const { prefs } = profile;
  const rules = activeConditions(profile).map((c) => RULES[c]);

  const unreliable = new Set<InputRung>(rules.flatMap((r) => r.unreliable ?? []));
  // Preferring text (e.g. privacy in public) is a preference, not an impairment signal.
  if (prefs.text_first) unreliable.add('voice');
  const reliable = LADDER.filter((rung) => rung !== 'switch' && !unreliable.has(rung));
  const [inputRung = 'switch', ...fallbacks] = [...reliable, 'switch' as const];

  const visual = profile.conditions.visual.active;
  const ageing = profile.conditions.ageing.active;
  const lowVision = prefs.text_scale > 1;
  const largeText = ageing || lowVision;
  const outputChannels: ResolvedMode['output_channels'] = visual
    ? largeText
      ? ['audio', 'large_text']
      : ['audio']
    : ['audio', largeText ? 'large_text' : 'visual'];

  return {
    schema_version: '1.0',
    input_channels: [inputRung, ...fallbacks],
    input_rung: inputRung,
    output_channels: outputChannels,
    // Speech rate is the user's own setting; conditions only set a starting default (below).
    tts_rate: clamp(prefs.tts_rate, 0.5, 2),
    scan_interval_ms: clamp(
      Math.max(BASE.scanIntervalMs, ...rules.map((r) => r.scanIntervalMs ?? 0)),
      500,
      5000,
    ),
    max_options: clamp(Math.min(BASE.maxOptions, ...rules.map((r) => r.maxOptions ?? 10)), 1, 10),
    verbosity:
      prefs.verbosity === 'short' || rules.some((r) => r.shortSummaries) ? 'short' : 'normal',
  };
}

/** The rung to fall back to after repeated failure. The switch is the floor. */
export function nextRung(mode: ResolvedMode, current: InputRung): InputRung {
  const i = mode.input_channels.indexOf(current);
  return mode.input_channels[Math.min(i + 1, mode.input_channels.length - 1)] ?? 'switch';
}

/**
 * Switch scanning speaks every highlighted item when visual is active (auditory scanning).
 * Needs the profile: ResolvedMode can't tell visual + ageing from ageing alone.
 */
export function isAuditoryScanning(profile: Profile): boolean {
  return profile.conditions.visual.active;
}

/**
 * Ageing: every action is confirmed, not only consequential ones. Not part of ResolvedMode 1.0;
 * kept here until a schema PR adds it (see docs/STATUS.md).
 */
export function confirmEveryAction(profile: Profile): boolean {
  return profile.conditions.ageing.active;
}

/** Slower starting speech for ageing; the user can change it afterwards. Track A's player
 *  moves in 0.25 steps, so this is the nearest step below normal. */
export const AGEING_START_RATE = 0.75;

type ConditionName = keyof Profile['conditions'];

/**
 * Turn a condition on (or off) in a profile draft and apply its starting defaults once.
 * Defaults never override a slower rate the user already chose.
 */
export function setConditionActive(
  draft: Profile,
  condition: ConditionName,
  active: boolean,
  source: 'inferred' | 'user',
  score = draft.conditions[condition].score,
): void {
  const wasActive = draft.conditions[condition].active;
  if (condition === 'colour') {
    draft.conditions.colour = { score, active, source: 'user' };
    return;
  }
  draft.conditions[condition] = { score, active, source };
  if (active && !wasActive && condition === 'ageing') {
    draft.prefs.tts_rate = Math.min(draft.prefs.tts_rate, AGEING_START_RATE);
  }
}

/** One step of the speech-rate control ("slower" / "faster"), kept within 0.5-2. Matches
 *  Track A's player, whose speeds are 0.25 apart. */
export const RATE_STEP = 0.25;
export function stepRate(rate: number, direction: 1 | -1): number {
  return clamp(Math.round((rate + direction * RATE_STEP) * 100) / 100, 0.5, 2);
}
