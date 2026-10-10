import { describe, expect, it } from 'vitest';
import type { Profile, ResolvedMode } from '@shared/index';
import profileFixture from '../../fixtures/mocks/Profile.json';
import modeFixture from '../../fixtures/mocks/ResolvedMode.json';
import {
  BASE,
  confirmEveryAction,
  isAuditoryScanning,
  nextRung,
  resolveMode,
  setConditionActive,
  stepRate,
} from '../src/core/composer';
import { defaultProfile } from '../src/core/profile';

type Condition = 'visual' | 'speech' | 'motor' | 'ageing';
const CONDITIONS: Condition[] = ['visual', 'speech', 'motor', 'ageing'];

/** Prefs first, then conditions turned on the way the app does it (starting defaults apply). */
function profile(active: Condition[], prefs: Partial<Profile['prefs']> = {}): Profile {
  const p = defaultProfile();
  p.prefs = { ...p.prefs, ...prefs };
  for (const c of active) setConditionActive(p, c, true, 'user', 1);
  return p;
}

const mode = (active: Condition[], prefs?: Partial<Profile['prefs']>) =>
  resolveMode(profile(active, prefs));

/** Every subset of the four conditions (16 combinations). */
const ALL_COMBINATIONS: Condition[][] = Array.from({ length: 16 }, (_, bits) =>
  CONDITIONS.filter((_, i) => bits & (1 << i)),
);

describe('composer: no conditions', () => {
  it('starts at voice with the full ladder, audio plus the normal overlay', () => {
    const m = mode([]);
    expect(m.input_rung).toBe('voice');
    expect(m.input_channels).toEqual(['voice', 'keyboard', 'phrase', 'switch']);
    expect(m.output_channels).toEqual(['audio', 'visual']);
    expect(m).toMatchObject({ tts_rate: 1, scan_interval_ms: 1500, max_options: 5 });
    expect(m.verbosity).toBe('normal');
  });

  it('ignores inferred scores until a condition is active (suggested, never applied)', () => {
    const p = defaultProfile();
    p.conditions.ageing = { score: 0.95, active: false, source: 'inferred' };
    expect(resolveMode(p)).toEqual(mode([]));
  });

  it('colour vision does not change the mode', () => {
    const p = defaultProfile();
    p.conditions.colour = { score: 1, active: true, source: 'user' };
    expect(resolveMode(p)).toEqual(mode([]));
  });
});

describe('composer: single conditions', () => {
  it('visual: audio output, voice first, slower auditory scanning', () => {
    const m = mode(['visual']);
    expect(m.output_channels).toEqual(['audio']);
    expect(m.input_rung).toBe('voice');
    expect(m.scan_interval_ms).toBe(2500);
  });

  it('visual with low vision (text_scale > 1) adds large text', () => {
    expect(mode(['visual'], { text_scale: 1.5 }).output_channels).toEqual(['audio', 'large_text']);
  });

  it('speech: voice is not relied on; starts at keyboard with prediction', () => {
    const m = mode(['speech']);
    expect(m.input_rung).toBe('keyboard');
    expect(m.input_channels).toEqual(['keyboard', 'phrase', 'switch']);
  });

  it('motor: full voice control first; keyboard is skipped in the fallback', () => {
    const m = mode(['motor']);
    expect(m.input_rung).toBe('voice');
    expect(m.input_channels).toEqual(['voice', 'phrase', 'switch']);
    expect(m.scan_interval_ms).toBe(2000);
  });

  it('ageing: large text, slower speech, 3 options, short summaries, confirm everything', () => {
    const p = profile(['ageing']);
    const m = resolveMode(p);
    expect(m.output_channels).toEqual(['audio', 'large_text']);
    expect(m.tts_rate).toBe(0.75);
    expect(m.max_options).toBe(3);
    expect(m.verbosity).toBe('short');
    expect(confirmEveryAction(p)).toBe(true);
  });
});

describe('composer: required combinations (docs/conditions.md)', () => {
  it('visual + motor -> auditory switch scanning', () => {
    const p = profile(['visual', 'motor']);
    const m = resolveMode(p);
    expect(isAuditoryScanning(p)).toBe(true);
    expect(m.output_channels).toEqual(['audio']);
    expect(m.scan_interval_ms).toBe(2500);
    // Voice still comes first; scanning is the fallback, ending at the switch.
    expect(m.input_channels).toEqual(['voice', 'phrase', 'switch']);
  });

  it('visual + speech -> keyboard/switch with spoken feedback; chips read out', () => {
    const p = profile(['visual', 'speech']);
    const m = resolveMode(p);
    expect(m.input_rung).toBe('keyboard');
    expect(m.input_channels).toEqual(['keyboard', 'phrase', 'switch']);
    expect(m.output_channels).toContain('audio');
    expect(isAuditoryScanning(p)).toBe(true);
  });

  it('scanning is only spoken when visual is active', () => {
    expect(isAuditoryScanning(profile(['motor']))).toBe(false);
    expect(isAuditoryScanning(profile(['ageing']))).toBe(false);
    expect(isAuditoryScanning(profile(['speech', 'motor']))).toBe(false);
  });

  it('speech + motor -> phrase chips driven by switch scanning', () => {
    const m = mode(['speech', 'motor']);
    expect(m.input_rung).toBe('phrase');
    expect(m.input_channels).toEqual(['phrase', 'switch']);
  });

  it.each(CONDITIONS.filter((c) => c !== 'ageing'))(
    'ageing + %s -> slower speech, at most 3 options, confirm every action',
    (other) => {
      const p = profile(['ageing', other]);
      const m = resolveMode(p);
      expect(m.tts_rate).toBeLessThanOrEqual(0.75);
      expect(m.max_options).toBeLessThanOrEqual(3);
      expect(confirmEveryAction(p)).toBe(true);
    },
  );

  it('demo persona: older blind user with a hand tremor', () => {
    const p = profile(['ageing', 'visual', 'motor']);
    const m = resolveMode(p);
    expect(m).toMatchObject({
      input_rung: 'voice',
      input_channels: ['voice', 'phrase', 'switch'],
      output_channels: ['audio', 'large_text'],
      tts_rate: 0.75,
      scan_interval_ms: 2500,
      max_options: 3,
      verbosity: 'short',
    });
    expect(isAuditoryScanning(p)).toBe(true);
  });
});

describe('composer: fixtures', () => {
  it('the Profile fixture resolves to the ResolvedMode fixture', () => {
    expect(resolveMode(profileFixture as Profile)).toEqual(modeFixture as unknown as ResolvedMode);
  });
});

describe('composer: prefs', () => {
  it('ageing starts speech slower, keeps an already-slower choice, and the user can change it', () => {
    expect(mode(['ageing']).tts_rate).toBe(0.75);
    expect(mode(['ageing'], { tts_rate: 0.7 }).tts_rate).toBe(0.7);
    const p = profile(['ageing']);
    p.prefs.tts_rate = stepRate(stepRate(p.prefs.tts_rate, 1), 1);
    expect(resolveMode(p).tts_rate).toBe(1.25);
  });

  it('turning ageing on again does not reset a rate the user changed while it was on', () => {
    const p = profile(['ageing']);
    p.prefs.tts_rate = 1.2;
    setConditionActive(p, 'ageing', true, 'user');
    expect(p.prefs.tts_rate).toBe(1.2);
  });

  it("speed steps by 0.25 (Track A's player) and stays within 0.5-2", () => {
    expect(stepRate(1, -1)).toBe(0.75);
    expect(stepRate(0.5, -1)).toBe(0.5);
    expect(stepRate(1.75, 1)).toBe(2);
    expect(stepRate(2, 1)).toBe(2);
  });

  it('text_first starts at keyboard without implying any impairment', () => {
    const m = mode([], { text_first: true });
    expect(m.input_rung).toBe('keyboard');
    expect(m.output_channels).toEqual(['audio', 'visual']);
  });

  it('verbosity short in prefs is respected', () => {
    expect(mode([], { verbosity: 'short' }).verbosity).toBe('short');
  });
});

describe('composer: invariants over all 16 combinations', () => {
  it.each(ALL_COMBINATIONS.map((c) => [c.join('+') || 'none', c] as const))(
    '%s: ends at the switch, stays in schema bounds',
    (_, active) => {
      const m = mode(active);
      expect(m.input_channels.at(-1)).toBe('switch');
      expect(m.input_channels[0]).toBe(m.input_rung);
      expect(m.output_channels.length).toBeGreaterThan(0);
      expect(m.scan_interval_ms).toBeGreaterThanOrEqual(500);
      expect(m.scan_interval_ms).toBeLessThanOrEqual(5000);
      expect(m.max_options).toBeGreaterThanOrEqual(1);
      expect(m.max_options).toBeLessThanOrEqual(10);
      expect(m.tts_rate).toBeGreaterThanOrEqual(0.5);
      expect(m.tts_rate).toBeLessThanOrEqual(2);
    },
  );

  it('adding a condition never makes pacing less restrictive', () => {
    for (const base of ALL_COMBINATIONS) {
      for (const extra of CONDITIONS.filter((c) => !base.includes(c))) {
        const before = mode(base);
        const after = mode([...base, extra]);
        expect(after.tts_rate).toBeLessThanOrEqual(before.tts_rate);
        expect(after.scan_interval_ms).toBeGreaterThanOrEqual(before.scan_interval_ms);
        expect(after.max_options).toBeLessThanOrEqual(before.max_options);
        if (before.verbosity === 'short') expect(after.verbosity).toBe('short');
      }
    }
  });

  it('falling back after failures walks the ladder and stops at the switch', () => {
    const m = mode([]);
    const seen = [m.input_rung];
    for (let i = 0; i < 5; i++) seen.push(nextRung(m, seen.at(-1)!));
    expect(seen).toEqual(['voice', 'keyboard', 'phrase', 'switch', 'switch', 'switch']);
    expect(BASE.maxOptions).toBe(5);
  });
});
