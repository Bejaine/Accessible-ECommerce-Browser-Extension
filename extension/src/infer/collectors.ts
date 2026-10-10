// Passive, throttled signal collectors in the content script (no Web Worker). Pointer moves are
// sampled at ~30 Hz; hover and scroll patterns are aggregated every 500 ms when the browser is
// idle. Only the signals docs/conditions.md lists as working are collected; devicePixelRatio,
// screen-reader browse keys and text selection are deliberately ignored.
// Speech, help-use and large-text signals come from the app (see `report` in app.ts).
import {
  backspaceRate,
  directionChanges,
  distanceToRect,
  pathEfficiency,
  pathLength,
  type Point,
} from './detectors';
import type { ScoreEngine } from './scores';

export const TUNING = {
  sampleEveryMs: 33,
  pathWindowMs: 1500,
  minPathPx: 150,
  lowEfficiency: 0.5,
  manyDirectionChanges: 6,
  repeatClickMs: 300,
  nearMissMs: 1000,
  nearMissPx: 40,
  longPressMs: 800,
  keyboardFocusMs: 500,
  pointerQuietMs: 1000,
  backspaceWindow: 40,
  backspaceMinKeys: 20,
  backspaceHigh: 0.25,
  hesitationMs: 15_000,
  longHoverMs: 3000,
  pinchScale: 1.5,
  aggregateEveryMs: 500,
  slowScrollBursts: 4,
  slowScrollWindowMs: 30_000,
} as const;

const INTERACTIVE =
  'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';

function interactive(target: EventTarget | null): Element | null {
  const el = target instanceof Element ? target : null;
  return el?.closest(INTERACTIVE) ?? null;
}

export interface CollectorOptions {
  root?: Document;
  win?: Window;
  now?: () => number;
}

/** Attach all collectors; returns a function that removes every listener. */
export function attachCollectors(engine: ScoreEngine, opts: CollectorOptions = {}): () => void {
  const doc = opts.root ?? document;
  const win = opts.win ?? window;
  const now = opts.now ?? (() => performance.now());
  const startedAt = now();
  const passive = { capture: true, passive: true } as const;
  const cleanups: (() => void)[] = [];

  const on = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void) => {
    doc.addEventListener(type, fn as EventListener, passive);
    cleanups.push(() => doc.removeEventListener(type, fn as EventListener, passive));
  };

  let samples: (Point & { t: number })[] = [];
  let lastSampleAt = -Infinity;
  let lastPointerDownAt = -Infinity;
  let lastPointerAt = -Infinity;
  let lastTabAt = -Infinity;
  let down: { at: number; target: Element | null; type: string } | null = null;
  let miss: (Point & { at: number }) | null = null;
  let lastClick: { at: number; target: Element } | null = null;
  let keys: string[] = [];
  let lastBackspaceSignal = -Infinity;
  let interacted = false;
  let hover: { el: Element; since: number; reported: boolean } | null = null;
  let scrollBursts: number[] = [];
  let lastScrollAt = -Infinity;

  function firstInteraction(t: number): void {
    if (interacted) return;
    interacted = true;
    // Measured from when collection started (page interactive), not from load.
    if (t - startedAt > TUNING.hesitationMs) engine.add('hesitation');
  }

  on('pointerdown', (e) => {
    const t = now();
    lastPointerDownAt = t;
    lastPointerAt = t;
    firstInteraction(t);
    const target = interactive(e.target);
    down = { at: t, target, type: e.pointerType };
    // Remember a press that missed every target; a press on a target keeps it for the click.
    if (!target) miss = { x: e.clientX, y: e.clientY, at: t };
  });

  on('pointerup', (e) => {
    const t = now();
    if (down && e.pointerType === 'touch' && down.target && t - down.at > TUNING.longPressMs) {
      engine.add('long_press');
    }
    down = null;
  });

  on('pointermove', (e) => {
    const t = now();
    lastPointerAt = t;
    if (t - lastSampleAt < TUNING.sampleEveryMs) return;
    lastSampleAt = t;
    samples.push({ x: e.clientX, y: e.clientY, t });
    samples = samples.filter((s) => t - s.t <= TUNING.pathWindowMs);
    if (e.pointerType === 'mouse') {
      const el = interactive(e.target);
      if (!el) hover = null;
      else if (hover?.el !== el) hover = { el, since: t, reported: false };
    }
  });

  on('click', (e) => {
    const t = now();
    firstInteraction(t);
    const target = interactive(e.target);
    hover = null;

    if (e.detail === 0 && t - lastPointerDownAt > TUNING.pointerQuietMs) {
      // Activated by keyboard or a screen reader.
      engine.add('click_without_pointer');
    } else {
      const recent = samples.filter((s) => t - s.t <= TUNING.pathWindowMs);
      if (pathLength(recent) >= TUNING.minPathPx) {
        if (pathEfficiency(recent) < TUNING.lowEfficiency) engine.add('low_path_efficiency');
        if (directionChanges(recent) >= TUNING.manyDirectionChanges)
          engine.add('direction_changes');
      }
      samples = [];
    }

    if (target) {
      if (lastClick && lastClick.target === target && t - lastClick.at < TUNING.repeatClickMs) {
        engine.add('repeat_click');
      }
      if (miss && t - miss.at < TUNING.nearMissMs) {
        if (distanceToRect(miss, target.getBoundingClientRect()) <= TUNING.nearMissPx) {
          engine.add('near_miss');
        }
      }
      lastClick = { at: t, target };
    }
    miss = null;
  });

  on('keydown', (e) => {
    const t = now();
    firstInteraction(t);
    if (e.key === 'Tab') lastTabAt = t;
    keys.push(e.key);
    if (keys.length > TUNING.backspaceWindow) keys = keys.slice(-TUNING.backspaceWindow);
    if (
      keys.length >= TUNING.backspaceMinKeys &&
      backspaceRate(keys) > TUNING.backspaceHigh &&
      t - lastBackspaceSignal > 10_000
    ) {
      lastBackspaceSignal = t;
      engine.add('backspace_rate');
    }
  });

  on('focusin', () => {
    const t = now();
    if (t - lastTabAt <= TUNING.keyboardFocusMs && t - lastPointerAt > TUNING.pointerQuietMs) {
      engine.add('focus_without_pointer');
    }
  });

  on('scroll', () => {
    const t = now();
    // A new burst starts after a pause; many short, separated bursts = slow staggered scrolling.
    if (t - lastScrollAt > 1000) scrollBursts.push(t);
    lastScrollAt = t;
  });

  // Contrast settings: a lasting state, reported once at start and on change.
  for (const query of ['(forced-colors: active)', '(prefers-contrast: more)']) {
    const mq = win.matchMedia?.(query);
    if (!mq) continue;
    if (mq.matches) engine.add('contrast_setting');
    const change = (e: MediaQueryListEvent) => e.matches && engine.add('contrast_setting');
    mq.addEventListener?.('change', change);
    cleanups.push(() => mq.removeEventListener?.('change', change));
  }

  // Pinch zoom (mobile). devicePixelRatio is NOT a zoom signal.
  const vv = win.visualViewport;
  if (vv) {
    let lastPinch = -Infinity;
    const resize = () => {
      const t = now();
      if (vv.scale > TUNING.pinchScale && t - lastPinch > 5000) {
        lastPinch = t;
        engine.add('pinch_zoom');
      }
    };
    vv.addEventListener('resize', resize, { passive: true });
    cleanups.push(() => vv.removeEventListener('resize', resize));
  }

  // Aggregation of slower patterns, every 500 ms when idle.
  const aggregate = () => {
    const t = now();
    if (hover && !hover.reported && t - hover.since > TUNING.longHoverMs) {
      hover.reported = true;
      engine.add('long_hover');
    }
    scrollBursts = scrollBursts.filter((b) => t - b <= TUNING.slowScrollWindowMs);
    if (scrollBursts.length >= TUNING.slowScrollBursts) {
      engine.add('slow_scroll');
      scrollBursts = [];
    }
  };
  const idle = (win as Window & { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback;
  const timer = win.setInterval(
    () => (idle ? idle.call(win, aggregate) : aggregate()),
    TUNING.aggregateEveryMs,
  );
  cleanups.push(() => win.clearInterval(timer));

  return () => cleanups.forEach((c) => c());
}
