import { afterEach, describe, expect, it, vi } from 'vitest';
import { announce, initAnnouncer, resetAnnouncer } from '../src/ui/announce';

describe('announce', () => {
  afterEach(() => {
    resetAnnouncer();
    vi.useRealTimers();
  });

  it('creates exactly one live region and writes announcements to it', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const region = initAnnouncer(root);
    initAnnouncer(root);
    expect(root.querySelectorAll('[aria-live]')).toHaveLength(1);
    announce('Added to cart');
    vi.advanceTimersByTime(100);
    expect(region.textContent).toBe('Added to cart');
    expect(region.getAttribute('role')).toBe('status');
  });
});
