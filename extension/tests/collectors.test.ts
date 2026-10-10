import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachCollectors, TUNING } from '../src/infer/collectors';
import {
  backspaceRate,
  directionChanges,
  distanceToRect,
  pathEfficiency,
} from '../src/infer/detectors';
import { createScoreEngine, type ScoreEngine } from '../src/infer/scores';

describe('detectors', () => {
  it('path efficiency: 1 for a straight line, low for a detour', () => {
    expect(
      pathEfficiency([
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 100, y: 0 },
      ]),
    ).toBeCloseTo(1);
    expect(
      pathEfficiency([
        { x: 0, y: 0 },
        { x: 0, y: 100 },
        { x: 100, y: 100 },
        { x: 100, y: 0 },
      ]),
    ).toBeCloseTo(1 / 3);
  });

  it('counts direction reversals but ignores tiny jitter', () => {
    const zigzag = [0, 20, 0, 20, 0].map((x, i) => ({ x, y: i * 10 }));
    expect(directionChanges(zigzag)).toBe(3);
    const jitter = [0, 1, 0, 1, 0].map((x) => ({ x, y: 0 }));
    expect(directionChanges(jitter)).toBe(0);
  });

  it('backspace rate and distance to a rectangle', () => {
    expect(backspaceRate(['a', 'Backspace', 'b', 'Backspace'])).toBe(0.5);
    expect(distanceToRect({ x: 5, y: 5 }, { left: 0, top: 0, right: 10, bottom: 10 })).toBe(0);
    expect(distanceToRect({ x: 13, y: 14 }, { left: 0, top: 0, right: 10, bottom: 10 })).toBe(5);
  });
});

describe('collectors', () => {
  let t = 0;
  let engine: ScoreEngine;
  let detach: () => void;
  let button: HTMLButtonElement;
  let other: HTMLButtonElement;
  let matches = false;

  const kinds = () => engine.log.map((s) => s.kind);
  const fire = (target: EventTarget, event: Event) => target.dispatchEvent(event);
  const pointer = (type: string, x = 0, y = 0, pointerType = 'mouse') =>
    new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerType });
  const click = (detail: number) => new MouseEvent('click', { bubbles: true, detail });
  const key = (k: string) => new KeyboardEvent('keydown', { bubbles: true, key: k });

  beforeEach(() => {
    vi.useFakeTimers();
    t = 0;
    matches = false;
    document.body.innerHTML = '<button id="a">Add to cart</button><button id="b">Buy</button>';
    button = document.querySelector('#a')!;
    other = document.querySelector('#b')!;
    engine = createScoreEngine({ now: () => t });
    const win = {
      matchMedia: (q: string) => ({
        matches: matches && q === '(forced-colors: active)',
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      setInterval: (fn: () => void, ms: number) => window.setInterval(fn, ms),
      clearInterval: (id: number) => window.clearInterval(id),
    } as unknown as Window;
    detach = attachCollectors(engine, { root: document, win, now: () => t });
  });

  afterEach(() => {
    detach();
    vi.useRealTimers();
  });

  it('keyboard/screen-reader activation: click with no pointer before it', () => {
    t = 5000;
    fire(button, click(0));
    expect(kinds()).toEqual(['click_without_pointer']);
  });

  it('an ordinary mouse click is not a keyboard signal', () => {
    t = 5000;
    fire(button, pointer('pointerdown'));
    fire(button, click(1));
    expect(kinds()).not.toContain('click_without_pointer');
  });

  it('Tab focus with no pointer use is a keyboard signal; with recent pointer use it is not', () => {
    t = 5000;
    fire(document.body, key('Tab'));
    fire(button, new FocusEvent('focusin', { bubbles: true }));
    expect(kinds()).toContain('focus_without_pointer');
    engine.reset();
    fire(document.body, pointer('pointermove'));
    t += 100;
    fire(document.body, key('Tab'));
    fire(other, new FocusEvent('focusin', { bubbles: true }));
    expect(kinds()).not.toContain('focus_without_pointer');
  });

  it('a wandering, zig-zag path before a click: low efficiency and direction changes', () => {
    const path = [0, 80, 10, 90, 20, 100, 30, 110, 40, 120].map((x, i) => [x, 100 + (i % 2) * 40]);
    for (const [x, y] of path) {
      t += TUNING.sampleEveryMs;
      fire(document.body, pointer('pointermove', x, y));
    }
    fire(button, pointer('pointerdown', 40, 100));
    fire(button, click(1));
    expect(kinds()).toEqual(expect.arrayContaining(['low_path_efficiency', 'direction_changes']));
  });

  it('a straight path is not a motor signal', () => {
    for (let x = 0; x <= 300; x += 30) {
      t += TUNING.sampleEveryMs;
      fire(document.body, pointer('pointermove', x, 100));
    }
    fire(button, pointer('pointerdown', 300, 100));
    fire(button, click(1));
    expect(kinds()).toEqual([]);
  });

  it('repeat clicks on the same target under 300 ms', () => {
    t = 5000;
    fire(button, pointer('pointerdown'));
    fire(button, click(1));
    t += 150;
    fire(button, pointer('pointerdown'));
    fire(button, click(2));
    expect(kinds()).toContain('repeat_click');
    engine.reset();
    t += 1000;
    fire(button, pointer('pointerdown'));
    fire(button, click(1));
    expect(kinds()).not.toContain('repeat_click');
  });

  it('a tap just outside a target followed by a retry on it is a near miss', () => {
    button.getBoundingClientRect = () => ({ left: 110, top: 0, right: 200, bottom: 40 }) as DOMRect;
    t = 5000;
    fire(document.body, pointer('pointerdown', 100, 10));
    t += 400;
    fire(button, pointer('pointerdown', 120, 10));
    fire(button, click(1));
    expect(kinds()).toContain('near_miss');
  });

  it('a long press on a target with touch', () => {
    t = 5000;
    fire(button, pointer('pointerdown', 0, 0, 'touch'));
    t += 900;
    fire(button, pointer('pointerup', 0, 0, 'touch'));
    expect(kinds()).toContain('long_press');
  });

  it('a high backspace rate while typing', () => {
    t = 5000;
    for (let i = 0; i < 20; i++) fire(document.body, key(i % 3 === 0 ? 'Backspace' : 'a'));
    expect(kinds()).toContain('backspace_rate');
  });

  it('hesitation counts from when the page became interactive, only past 15 s', () => {
    t = 16_000;
    fire(button, pointer('pointerdown'));
    expect(kinds()).toContain('hesitation');
  });

  it('no hesitation signal for a quick first interaction', () => {
    t = 2000;
    fire(button, pointer('pointerdown'));
    expect(kinds()).not.toContain('hesitation');
  });

  it('long hover over a target without clicking (aggregated every 500 ms)', () => {
    t = 1000;
    fire(button, pointer('pointermove', 5, 5));
    t += 3500;
    vi.advanceTimersByTime(TUNING.aggregateEveryMs);
    expect(kinds()).toEqual(['long_hover']);
    vi.advanceTimersByTime(TUNING.aggregateEveryMs * 4);
    expect(kinds()).toEqual(['long_hover']);
  });

  it('forced colours is reported once at start', () => {
    detach();
    engine.reset();
    matches = true;
    const win = {
      matchMedia: (q: string) => ({
        matches: q === '(forced-colors: active)',
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      setInterval: (fn: () => void, ms: number) => window.setInterval(fn, ms),
      clearInterval: (id: number) => window.clearInterval(id),
    } as unknown as Window;
    detach = attachCollectors(engine, { root: document, win, now: () => t });
    expect(kinds()).toEqual(['contrast_setting']);
  });

  it('detaching removes every listener', () => {
    detach();
    t = 5000;
    fire(button, click(0));
    expect(kinds()).toEqual([]);
    detach = () => undefined;
  });
});
