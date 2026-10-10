// The single ARIA live region. Every announcement in the extension goes through here.
//
// Each message is appended as its own node (aria-relevant="additions"), so two announcements
// in quick succession are both read instead of the second overwriting the first. Old nodes are
// pruned; removals are not announced.

const MAX_MESSAGES = 3;
const CLEAR_AFTER_MS = 7000;
// A region that was just inserted isn't registered by every screen reader yet; wait a tick.
const SETTLE_MS = 50;

let region: HTMLElement | null = null;
/** Optional: the assistant's own voice, for users without a screen reader (set by the app). */
let voice: ((text: string) => void) | null = null;

export function setAnnounceVoice(speak: ((text: string) => void) | null): void {
  voice = speak;
}
const timers = new Set<ReturnType<typeof setTimeout>>();

function later(fn: () => void, ms: number): void {
  const id = setTimeout(() => {
    timers.delete(id);
    fn();
  }, ms);
  timers.add(id);
}

/** Create the live region inside `root` (the overlay's shadow-root container). Idempotent. */
export function initAnnouncer(root: HTMLElement | ShadowRoot): HTMLElement {
  if (region?.isConnected) return region;
  region = document.createElement('div');
  region.id = 'asl-live';
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'false');
  region.setAttribute('aria-relevant', 'additions text');
  region.className = 'asl-visually-hidden';
  root.appendChild(region);
  return region;
}

/**
 * Announce text to screen readers. `assertive` interrupts (errors, secure-zone notices,
 * confirmations); everything else waits its turn.
 */
export function announce(
  text: string,
  { assertive = false, speak = true }: { assertive?: boolean; speak?: boolean } = {},
): void {
  if (!text.trim()) return;
  if (speak) voice?.(text);
  const el = region;
  if (!el) return;
  if (assertive) el.replaceChildren();
  el.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
  later(() => {
    if (!el.isConnected) return;
    const msg = document.createElement('p');
    msg.textContent = text;
    el.appendChild(msg);
    while (el.childElementCount > MAX_MESSAGES) el.firstElementChild?.remove();
    later(() => {
      msg.remove();
      if (el.childElementCount === 0) el.setAttribute('aria-live', 'polite');
    }, CLEAR_AFTER_MS);
  }, SETTLE_MS);
}

/** For tests and teardown. */
export function resetAnnouncer(): void {
  timers.forEach(clearTimeout);
  timers.clear();
  region?.remove();
  region = null;
  voice = null;
}
