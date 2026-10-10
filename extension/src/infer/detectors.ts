// Pure measurements used by the collectors. Kept separate so thresholds are unit-testable.

export interface Point {
  x: number;
  y: number;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Total distance travelled along the samples. */
export function pathLength(samples: Point[]): number {
  let total = 0;
  for (let i = 1; i < samples.length; i++) total += dist(samples[i - 1]!, samples[i]!);
  return total;
}

/** Straight-line distance / travelled distance (1 = perfectly direct). */
export function pathEfficiency(samples: Point[]): number {
  const total = pathLength(samples);
  if (samples.length < 2 || total < 1) return 1;
  return dist(samples[0]!, samples.at(-1)!) / total;
}

/** Reversals of horizontal or vertical direction, ignoring jitter below `minStep` px. */
export function directionChanges(samples: Point[], minStep = 2): number {
  let changes = 0;
  let lastDx = 0;
  let lastDy = 0;
  for (let i = 1; i < samples.length; i++) {
    const dx = samples[i]!.x - samples[i - 1]!.x;
    const dy = samples[i]!.y - samples[i - 1]!.y;
    if (Math.abs(dx) >= minStep) {
      if (lastDx !== 0 && Math.sign(dx) !== Math.sign(lastDx)) changes++;
      lastDx = dx;
    }
    if (Math.abs(dy) >= minStep) {
      if (lastDy !== 0 && Math.sign(dy) !== Math.sign(lastDy)) changes++;
      lastDy = dy;
    }
  }
  return changes;
}

/** Share of Backspace among recent keys. */
export function backspaceRate(keys: string[]): number {
  if (keys.length === 0) return 0;
  return keys.filter((k) => k === 'Backspace').length / keys.length;
}

/** Distance from a point to a rectangle (0 if inside). */
export function distanceToRect(
  p: Point,
  r: { left: number; top: number; right: number; bottom: number },
): number {
  const dx = Math.max(r.left - p.x, 0, p.x - r.right);
  const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
  return Math.hypot(dx, dy);
}
