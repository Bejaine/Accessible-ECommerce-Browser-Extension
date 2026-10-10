import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announce, initAnnouncer, resetAnnouncer } from '../src/ui/announce';

describe('announce', () => {
  let root: HTMLElement;
  let region: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    root = document.createElement('div');
    document.body.appendChild(root);
    region = initAnnouncer(root);
  });

  afterEach(() => {
    resetAnnouncer();
    root.remove();
    vi.useRealTimers();
  });

  const messages = () => [...region.children].map((c) => c.textContent);

  it('creates exactly one polite status region', () => {
    initAnnouncer(root);
    expect(root.querySelectorAll('[aria-live]')).toHaveLength(1);
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
  });

  it('keeps both of two quick announcements instead of overwriting', () => {
    announce('Added to cart');
    announce('Cart has 2 items');
    vi.advanceTimersByTime(100);
    expect(messages()).toEqual(['Added to cart', 'Cart has 2 items']);
  });

  it('re-announces an identical message as a new node', () => {
    announce('Listening');
    vi.advanceTimersByTime(100);
    announce('Listening');
    vi.advanceTimersByTime(100);
    expect(messages()).toEqual(['Listening', 'Listening']);
  });

  it('assertive messages interrupt queued ones, then the region returns to polite', () => {
    announce('Loading reviews');
    vi.advanceTimersByTime(100);
    announce('Listening has stopped.', { assertive: true });
    expect(region.getAttribute('aria-live')).toBe('assertive');
    vi.advanceTimersByTime(100);
    expect(messages()).toEqual(['Listening has stopped.']);
    vi.advanceTimersByTime(10_000);
    expect(messages()).toEqual([]);
    expect(region.getAttribute('aria-live')).toBe('polite');
  });

  it('ignores blank text and prunes old messages', () => {
    announce('   ');
    for (let i = 0; i < 5; i++) announce(`m${i}`);
    vi.advanceTimersByTime(100);
    expect(messages()).toEqual(['m2', 'm3', 'm4']);
  });
});
