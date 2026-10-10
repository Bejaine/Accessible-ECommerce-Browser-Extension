// Dwell to click (motor stretch, opt-in in Settings): resting the mouse or pen on one of the
// assistant's own controls for `ms` clicks it. Only inside our shadow root: the shop's page is
// never clicked this way, and anything consequential still asks for confirmation (rule 3).
// - Staying on the control is what counts, not holding perfectly still, so a tremor is fine.
// - After a dwell click the pointer must leave that control before it can fire again.
// - Touch is ignored (a tap already clicks). The control shows a dashed outline while dwelling;
//   the filling bar is only animated when reduced motion is not requested.
export const DWELL_CSS = `
.asl-dwelling { outline: 4px dashed var(--asl-fg) !important; outline-offset: 3px;
  background-image: linear-gradient(var(--asl-accent), var(--asl-accent));
  background-repeat: no-repeat; background-position: left bottom; background-size: 0% 6px;
  animation: asl-dwell var(--asl-dwell-ms, 1200ms) linear forwards; }
@keyframes asl-dwell { to { background-size: 100% 6px; } }
@media (prefers-reduced-motion: reduce) {
  .asl-dwelling { animation: none; background-size: 100% 6px; }
}
@media (forced-colors: active) { .asl-dwelling { outline-color: Highlight !important; } }
`;

export const DWELL_TIMES_MS = [800, 1200, 1600, 2000] as const;
export const DEFAULT_DWELL_MS = 1200;

const CLICKABLE = 'button, [role="button"], a[href], input, select, summary';

export interface Dwell {
  setTime(ms: number): void;
  detach(): void;
}

export function attachDwell(root: Document | ShadowRoot, ms = DEFAULT_DWELL_MS): Dwell {
  let time = ms;
  let target: HTMLElement | null = null;
  /** The control that just fired; it can't fire again until the pointer leaves it. */
  let fired: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clear(): void {
    clearTimeout(timer);
    target?.classList.remove('asl-dwelling');
    target = null;
  }

  function controlAt(e: PointerEvent): HTMLElement | null {
    for (const node of e.composedPath()) {
      if (node === root) break;
      if (node instanceof HTMLElement && node.matches(CLICKABLE)) {
        const disabled = node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true';
        return disabled ? null : node;
      }
    }
    return null;
  }

  const onMove = (event: Event) => {
    const e = event as PointerEvent;
    if (e.pointerType === 'touch') return;
    const control = controlAt(e);
    if (control !== fired) fired = null;
    if (control === target) return;
    clear();
    if (!control || control === fired) return;
    target = control;
    control.style.setProperty('--asl-dwell-ms', `${time}ms`);
    control.classList.add('asl-dwelling');
    timer = setTimeout(() => {
      const chosen = target;
      clear();
      if (!chosen?.isConnected) return;
      fired = chosen;
      chosen.click();
    }, time);
  };
  // Leaving a control (also straight onto the shop's page, where no pointermove reaches us).
  const onOut = (event: Event) => {
    const e = event as PointerEvent;
    const to = e.relatedTarget as Node | null;
    if (target && !(to && target.contains(to))) clear();
    if (fired && !(to && fired.contains(to))) fired = null;
  };

  root.addEventListener('pointermove', onMove, { passive: true });
  root.addEventListener('pointerover', onMove, { passive: true });
  root.addEventListener('pointerout', onOut, { passive: true });
  return {
    setTime(next) {
      time = next;
    },
    detach() {
      clear();
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerover', onMove);
      root.removeEventListener('pointerout', onOut);
    },
  };
}
