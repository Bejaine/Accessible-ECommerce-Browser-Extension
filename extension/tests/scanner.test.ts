import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionTarget } from '@shared/index';
import searchPage from '../../fixtures/mocks/PageContext.search.json';
import turnRequest from '../../fixtures/mocks/TurnRequest.json';
import { groupsFromTargets } from '../src/ui/scanGroups';
import { BACK_ID, createScanner, type Highlight, type ScanGroup } from '../src/ui/scanner';
import { attachSwitch } from '../src/ui/switchInput';

const productTargets = turnRequest.page.targets as ActionTarget[];
const searchTargets = searchPage.targets as ActionTarget[];

function setup(groups: ScanGroup[], extra: { speak?: (t: string) => void } = {}) {
  const seen: (Highlight | null)[] = [];
  const scanner = createScanner({
    intervalMs: 1000,
    backLabel: 'Back',
    pausedLabel: 'Scanning paused',
    onHighlight: (h) => seen.push(h),
    ...extra,
  });
  scanner.start(groups);
  const label = () => {
    const h = scanner.highlight;
    return h ? (h.item?.label ?? `[${h.group.label}]`) : null;
  };
  return { scanner, seen, label };
}

const item = (id: string, activate = vi.fn()) => ({ id, label: id, activate });

describe('scan groups from page targets', () => {
  it('groups by zone in a fixed order and skips disabled targets', () => {
    const groups = groupsFromTargets(productTargets, vi.fn());
    expect(groups.map((g) => g.label)).toEqual(['Search', 'Product', 'Cart']);
    expect(groups[1]!.items.map((i) => i.label)).toContain('Add to Cart');

    const disabled = productTargets.map((t) =>
      t.id === 't-buy-now'
        ? { ...t, state: { disabled: true, selected: false, expanded: false } }
        : t,
    );
    const product = groupsFromTargets(disabled, vi.fn()).find((g) => g.id === 'product')!;
    expect(product.items.map((i) => i.id)).not.toContain('t-buy-now');
  });

  it('selecting a target hands it to onSelect (no direct click on the shop page)', () => {
    const onSelect = vi.fn();
    const results = groupsFromTargets(searchTargets, onSelect).find((g) => g.id === 'results')!;
    results.items[0]!.activate();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 't-r1', zone: 'results' }));
  });
});

describe('scanner (two-level)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('cycles groups, enters one, cycles its items with Back, and selects', () => {
    const add = vi.fn();
    const { scanner, label } = setup([
      { id: 'search', label: 'Search', items: [item('Search box')] },
      { id: 'product', label: 'Product', items: [item('Black'), item('Add to Cart', add)] },
    ]);
    expect(label()).toBe('[Search]');
    vi.advanceTimersByTime(1000);
    expect(label()).toBe('[Product]');
    scanner.press();
    expect(label()).toBe('Black');
    vi.advanceTimersByTime(1000);
    expect(label()).toBe('Add to Cart');
    vi.advanceTimersByTime(1000);
    expect(scanner.highlight?.item?.id).toBe(BACK_ID);
    vi.advanceTimersByTime(1000);
    expect(label()).toBe('Black');
    vi.advanceTimersByTime(1000);
    scanner.press();
    expect(add).toHaveBeenCalledOnce();
    expect(scanner.level).toBe('groups');
  });

  it('Back returns to the group level on the same group', () => {
    const { scanner, label } = setup([
      { id: 'a', label: 'A', items: [item('a1')] },
      { id: 'b', label: 'B', items: [item('b1')] },
    ]);
    vi.advanceTimersByTime(1000);
    scanner.press();
    vi.advanceTimersByTime(1000);
    expect(scanner.highlight?.item?.id).toBe(BACK_ID);
    scanner.press();
    expect(label()).toBe('[B]');
  });

  it('skips the group level when there is only one group (and has no Back)', () => {
    const { scanner, label } = setup([
      { id: 'p', label: 'Phrases', items: [item('Yes'), item('No')] },
    ]);
    expect(scanner.level).toBe('items');
    expect(label()).toBe('Yes');
    vi.advanceTimersByTime(2000);
    expect(label()).toBe('Yes');
  });

  it('speaks every highlight when auditory scanning is on', () => {
    const speak = vi.fn();
    setup(
      [
        { id: 'a', label: 'Search', items: [item('x')] },
        { id: 'b', label: 'Product', items: [item('y')] },
      ],
      { speak },
    );
    vi.advanceTimersByTime(1000);
    expect(speak.mock.calls.map((c) => c[0])).toEqual(['Search', 'Product']);
  });

  it('pauses after 3 rounds without a press, never selects on its own, and resumes on press', () => {
    const chosen = vi.fn();
    const speak = vi.fn();
    const { scanner, label } = setup(
      [
        { id: 'a', label: 'A', items: [item('a1', chosen)] },
        { id: 'b', label: 'B', items: [item('b1', chosen)] },
      ],
      { speak },
    );
    vi.advanceTimersByTime(6000);
    expect(scanner.level).toBe('paused');
    expect(speak).toHaveBeenLastCalledWith('Scanning paused');
    vi.advanceTimersByTime(60_000);
    expect(scanner.level).toBe('paused');
    expect(chosen).not.toHaveBeenCalled();
    scanner.press();
    expect(scanner.level).toBe('groups');
    expect(label()).toBe('[A]');
  });

  it('ignores empty groups and stops when there is nothing to scan', () => {
    const { scanner } = setup([{ id: 'e', label: 'Empty', items: [] }]);
    expect(scanner.level).toBe('stopped');
    scanner.press();
    expect(scanner.level).toBe('stopped');
  });
});

describe('switch key', () => {
  let now = 0;
  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });
  afterEach(() => vi.restoreAllMocks());

  const key = (code: string, repeat = false) =>
    new KeyboardEvent('keydown', { code, repeat, bubbles: true, cancelable: true });

  it('fires on the configured key only, ignores auto-repeat, debounces tremor presses', () => {
    const onPress = vi.fn();
    const detach = attachSwitch(document, { code: 'Space', onPress, debounceMs: 300 });
    const ev = key('Space');
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    document.body.dispatchEvent(key('KeyA'));
    document.body.dispatchEvent(key('Space', true));
    now = 100;
    document.body.dispatchEvent(key('Space'));
    now = 500;
    document.body.dispatchEvent(key('Space'));
    expect(onPress).toHaveBeenCalledTimes(2);
    detach();
    now = 2000;
    document.body.dispatchEvent(key('Space'));
    expect(onPress).toHaveBeenCalledTimes(2);
  });
});
