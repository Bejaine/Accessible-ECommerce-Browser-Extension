// Single-switch scanning engine (two-level: groups such as page zones, then items in a group).
// Pure logic + timers; the scan bar and the switch listener are separate.
//
// - Highlight moves every `intervalMs`; one press selects. In a group, a final "Back" item returns
//   to the group level. With a single group the group level is skipped.
// - When `speak` is given (auditory scanning: visual is active), every highlight is spoken.
// - No time limit on the user: after `maxCycles` full rounds without a press, scanning pauses
//   and the next press resumes it. It never selects anything on its own.
// - Adaptive speed (optional, motor stretch): a press that lands just after the highlight moved
//   was probably aimed at the item before, so scanning slows down (20 %, up to `maxMs`). After
//   five unhurried presses in a row it speeds back up (10 %), but never faster than `intervalMs`:
//   the composer's pace is the floor. A press still selects what is highlighted, so what happens
//   stays predictable; anything consequential is confirmed anyway.

export interface ScanItem {
  id: string;
  label: string;
  activate(): void;
}

export interface ScanGroup {
  id: string;
  label: string;
  items: ScanItem[];
}

export type ScanLevel = 'groups' | 'items' | 'paused' | 'stopped';

export interface Highlight {
  level: 'groups' | 'items';
  group: ScanGroup;
  /** null while the group itself is highlighted; the BACK item has id `__back`. */
  item: ScanItem | null;
}

export interface ScannerOptions {
  intervalMs: number;
  backLabel: string;
  pausedLabel: string;
  onHighlight?: (h: Highlight | null) => void;
  speak?: (text: string) => void;
  maxCycles?: number;
  adaptive?: { maxMs: number; onChange?: (intervalMs: number) => void };
  now?: () => number;
}

export interface Scanner {
  readonly level: ScanLevel;
  readonly highlight: Highlight | null;
  /** The current pace (changes only with `adaptive`). */
  readonly intervalMs: number;
  start(groups: ScanGroup[]): void;
  /** The single switch. */
  press(): void;
  stop(): void;
}

export const BACK_ID = '__back';
/** Adaptive scanning: a press this soon after a move counts as late. */
export const LATE_PRESS_MS = 300;
export const STEADY_PRESSES = 5;

/** The late window grows with the pace (15 % of it, at least LATE_PRESS_MS). */
export const lateWindow = (intervalMs: number) => Math.max(LATE_PRESS_MS, intervalMs * 0.15);

export function createScanner(opts: ScannerOptions): Scanner {
  const maxCycles = opts.maxCycles ?? 3;
  let groups: ScanGroup[] = [];
  let level: ScanLevel = 'stopped';
  let resumeLevel: 'groups' | 'items' = 'groups';
  let groupIndex = 0;
  let itemIndex = 0;
  let cycles = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const now = opts.now ?? Date.now;
  let interval = opts.intervalMs;
  let movedAt = 0;
  let steady = 0;

  const singleGroup = () => groups.length === 1;
  const back: ScanItem = { id: BACK_ID, label: opts.backLabel, activate: () => undefined };
  const itemsOf = (g: ScanGroup) => (singleGroup() ? g.items : [...g.items, back]);

  function current(): Highlight | null {
    const group = groups[groupIndex];
    if (!group || (level !== 'groups' && level !== 'items')) return null;
    if (level === 'groups') return { level, group, item: null };
    return { level, group, item: itemsOf(group)[itemIndex] ?? null };
  }

  function show(): void {
    const h = current();
    opts.onHighlight?.(h);
    if (h) opts.speak?.(h.item ? h.item.label : h.group.label);
  }

  function schedule(): void {
    clearTimeout(timer);
    timer = setTimeout(advance, interval);
  }

  function advance(): void {
    if (level === 'groups') {
      groupIndex = (groupIndex + 1) % groups.length;
      if (groupIndex === 0) cycles++;
    } else if (level === 'items') {
      const group = groups[groupIndex];
      if (!group) return;
      itemIndex = (itemIndex + 1) % itemsOf(group).length;
      if (itemIndex === 0) cycles++;
    } else {
      return;
    }
    if (cycles >= maxCycles) {
      resumeLevel = level;
      level = 'paused';
      clearTimeout(timer);
      opts.onHighlight?.(null);
      opts.speak?.(opts.pausedLabel);
      return;
    }
    movedAt = now();
    show();
    schedule();
  }

  /** Adaptive speed: judge one press by how soon it came after the last move. */
  function adapt(): void {
    if (!opts.adaptive) return;
    const sinceMove = now() - movedAt;
    let next = interval;
    if (movedAt > 0 && sinceMove < lateWindow(interval)) {
      steady = 0;
      next = Math.min(opts.adaptive.maxMs, Math.round(interval * 1.2));
    } else if (++steady >= STEADY_PRESSES) {
      steady = 0;
      next = Math.max(opts.intervalMs, Math.round(interval * 0.9));
    }
    if (next !== interval) {
      interval = next;
      opts.adaptive.onChange?.(interval);
    }
  }

  function enter(newLevel: 'groups' | 'items', g = 0, i = 0): void {
    level = newLevel;
    groupIndex = g;
    itemIndex = i;
    cycles = 0;
    movedAt = 0; // a new level starts fresh: the first press there is never "late"
    show();
    schedule();
  }

  return {
    get level() {
      return level;
    },
    get highlight() {
      return current();
    },
    get intervalMs() {
      return interval;
    },
    start(newGroups) {
      groups = newGroups.filter((g) => g.items.length > 0);
      if (groups.length === 0) {
        this.stop();
        return;
      }
      enter(singleGroup() ? 'items' : 'groups');
    },
    press() {
      if (level === 'stopped') return;
      if (level === 'paused') {
        enter(resumeLevel, groupIndex, 0);
        return;
      }
      const h = current();
      if (!h) return;
      adapt();
      if (level === 'groups') {
        enter('items', groupIndex, 0);
      } else if (h.item?.id === BACK_ID) {
        enter('groups', groupIndex);
      } else if (h.item) {
        const chosen = h.item;
        enter(singleGroup() ? 'items' : 'groups');
        chosen.activate();
      }
    },
    stop() {
      clearTimeout(timer);
      level = 'stopped';
      opts.onHighlight?.(null);
    },
  };
}
