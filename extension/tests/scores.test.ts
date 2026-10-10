import { describe, expect, it } from 'vitest';
import { createScoreEngine, SUGGEST_THRESHOLD, type SignalKind } from '../src/infer/scores';

function engineAt() {
  let t = 0;
  const engine = createScoreEngine({ now: () => t, halfLifeMs: 60_000 });
  const add = (kind: SignalKind, times = 1) => {
    for (let i = 0; i < times; i++) engine.add(kind);
  };
  return { engine, add, advance: (ms: number) => (t += ms) };
}

describe('score engine', () => {
  it('starts at zero for every inferred condition (colour is never inferred)', () => {
    const { engine } = engineAt();
    const s = engine.scores();
    expect(Object.keys(s)).toEqual(['visual', 'speech', 'motor', 'ageing']);
    expect(Object.values(s).every((c) => c.score === 0 && !c.ready)).toBe(true);
  });

  it('one signal group, however often it fires, never reaches the threshold', () => {
    const { engine, add } = engineAt();
    add('repeat_click', 100);
    const motor = engine.scores().motor;
    expect(motor.score).toBeLessThan(SUGGEST_THRESHOLD);
    expect(motor.groupCount).toBe(1);
    expect(motor.ready).toBe(false);
  });

  it('two independent motor groups make a suggestion possible', () => {
    const { engine, add } = engineAt();
    add('repeat_click', 10);
    add('low_path_efficiency', 10);
    const motor = engine.scores().motor;
    expect(motor.score).toBeGreaterThanOrEqual(SUGGEST_THRESHOLD);
    expect(motor.groupCount).toBe(2);
    expect(motor.ready).toBe(true);
  });

  it('keyboard clicks and focus moves are one group: keyboard use alone never suggests visual', () => {
    const { engine, add } = engineAt();
    add('click_without_pointer', 50);
    add('focus_without_pointer', 50);
    const visual = engine.scores().visual;
    expect(Object.keys(visual.groups)).toEqual(['keyboard']);
    expect(visual.ready).toBe(false);
  });

  it('keyboard use plus a contrast setting is enough for visual', () => {
    const { engine, add } = engineAt();
    add('click_without_pointer', 20);
    add('contrast_setting');
    expect(engine.scores().visual.ready).toBe(true);
  });

  it('ageing needs three groups, not two', () => {
    const { engine, add } = engineAt();
    add('hesitation', 10);
    add('long_hover', 10);
    expect(engine.scores().ageing.ready).toBe(false);
    add('help_use', 10);
    expect(engine.scores().ageing.ready).toBe(true);
  });

  it('evidence decays over time', () => {
    const { engine, add, advance } = engineAt();
    add('repeat_click', 10);
    add('near_miss', 10);
    expect(engine.scores().motor.ready).toBe(true);
    advance(60_000);
    const later = engine.scores().motor;
    expect(later.ready).toBe(false);
    expect(later.groups.repeat_click).toBeCloseTo(0.25, 5);
  });

  it('keeps a bounded log for calibration and can reset', () => {
    const { engine, add } = engineAt();
    add('long_press', 600);
    expect(engine.log).toHaveLength(500);
    engine.reset();
    expect(engine.log).toHaveLength(0);
    expect(engine.scores().motor.score).toBe(0);
  });
});
