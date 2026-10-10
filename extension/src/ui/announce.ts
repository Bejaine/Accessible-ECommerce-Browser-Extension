// The single ARIA live region. Every announcement in the extension goes through here.
let region: HTMLElement | null = null;
let pending: ReturnType<typeof setTimeout> | undefined;

/** Create the live region inside `root` (the overlay's shadow root container). Idempotent. */
export function initAnnouncer(root: HTMLElement | ShadowRoot): HTMLElement {
  if (region?.isConnected) return region;
  region = document.createElement('div');
  region.id = 'asl-live';
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  region.className = 'asl-visually-hidden';
  root.appendChild(region);
  return region;
}

/** Announce text. Clears first so repeating the same message is still read out. */
export function announce(text: string, { assertive = false } = {}): void {
  if (!region) return;
  const el = region;
  el.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
  el.textContent = '';
  clearTimeout(pending);
  pending = setTimeout(() => {
    el.textContent = text;
  }, 50);
}

/** For tests and teardown. */
export function resetAnnouncer(): void {
  clearTimeout(pending);
  region?.remove();
  region = null;
}
