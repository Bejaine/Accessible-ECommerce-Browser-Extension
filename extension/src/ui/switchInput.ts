// The single switch as a key (Prefs.switch_key, a KeyboardEvent.code such as "Space").
// Key repeat is ignored and presses closer together than `debounceMs` count once, so a tremor
// doesn't select twice. Taps go through the scan bar's Choose button instead.

export interface SwitchOptions {
  code: string;
  onPress: () => void;
  debounceMs?: number;
}

export function attachSwitch(target: Document | HTMLElement, opts: SwitchOptions): () => void {
  const debounceMs = opts.debounceMs ?? 300;
  let last = -Infinity;
  const handler = (e: Event) => {
    const key = e as KeyboardEvent;
    if (key.code !== opts.code) return;
    key.preventDefault();
    key.stopPropagation();
    if (key.repeat) return;
    const now = performance.now();
    if (now - last < debounceMs) return;
    last = now;
    opts.onPress();
  };
  target.addEventListener('keydown', handler, { capture: true });
  return () => target.removeEventListener('keydown', handler, { capture: true });
}
