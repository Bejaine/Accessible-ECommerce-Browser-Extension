// Single-switch scanning engine (two-level: groups such as page zones, then items in a group).
// Pure logic + timers; the scan bar and the switch listener are separate.
//
// - Highlight moves every `intervalMs`; one press selects. In a group, a final "Back" item returns
//   to the group level. With a single group the group level is skipped.
// - When `speak` is given (auditory scanning: visual is active), every highlight is spoken.
// - No time limit on the user: after `maxCycles` full rounds without a press, scanning pauses
//   and the next press resumes it. It never selects anything on its own.

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
}

export interface Scanner {
  readonly level: ScanLevel;
  readonly highlight: Highlight | null;
  start(groups: ScanGroup[]): void;
  /** The single switch. */
  press(): void;
  stop(): void;
}

export const BACK_ID = '__back';

export function createScanner(opts: ScannerOptions): Scanner {
  const maxCycles = opts.maxCycles ?? 3;
  let groups: ScanGroup[] = [];
  let level: ScanLevel = 'stopped';
  let resumeLevel: 'groups' | 'items' = 'groups';
  let groupIndex = 0;
  let itemIndex = 0;
  let cycles = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

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
    timer = setTimeout(advance, opts.intervalMs);
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
    show();
    schedule();
  }

  function enter(newLevel: 'groups' | 'items', g = 0, i = 0): void {
    level = newLevel;
    groupIndex = g;
    itemIndex = i;
    cycles = 0;
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
