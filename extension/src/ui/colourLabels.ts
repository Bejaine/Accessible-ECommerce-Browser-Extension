// Colour names on swatches (optional colour-vision setting, chosen by the user only).
// Names come from Track B's page map (`colour_name`, from the swatch's title/alt/label). We draw
// our own small labels next to each swatch in the overlay's shadow root: the shop's page is not
// modified or restyled (rule 11), the labels never take clicks, and they follow scrolling.
// Swatches without a name on the page are left unlabelled (no guessing; a VLM is a stretch goal).
// When a swatch gets keyboard focus, its colour is also announced.
import type { ActionTarget } from '@shared/index';
import { announce } from './announce';

export const COLOUR_LABEL_CSS = `
.asl-colour-layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
.asl-colour-label { position: fixed; transform: translateY(-100%); padding: 1px 6px; border-radius: 4px;
  font: 600 12px/1.4 system-ui, sans-serif; white-space: nowrap; max-inline-size: 160px; overflow: hidden;
  text-overflow: ellipsis; color: #111; background: #fff; border: 2px solid #111; }
@media (forced-colors: active) {
  .asl-colour-label { color: CanvasText; background: Canvas; border-color: CanvasText; }
}
`;

export interface ColourLabels {
  render(targets: ActionTarget[]): void;
  destroy(): void;
}

export function createColourLabels(
  layerParent: HTMLElement,
  resolve: (id: string) => Element | null,
): ColourLabels {
  const layer = document.createElement('div');
  layer.className = 'asl-colour-layer';
  layer.setAttribute('aria-hidden', 'true'); // visual aid only; names are announced on focus
  layerParent.append(layer);

  let swatches: { target: ActionTarget; el: Element; tag: HTMLElement }[] = [];
  let frame = 0;

  function position(): void {
    frame = 0;
    for (const { el, tag } of swatches) {
      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.bottom > 0 && r.top < innerHeight;
      tag.hidden = !visible;
      if (!visible) continue;
      tag.style.left = `${Math.max(0, r.left)}px`;
      tag.style.top = `${Math.max(16, r.top - 2)}px`;
    }
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(position);
  };

  const onFocus = (e: FocusEvent) => {
    const hit = swatches.find((s) => s.el === e.target || s.el.contains(e.target as Node));
    if (hit?.target.colour_name) announce(hit.target.colour_name);
  };

  addEventListener('scroll', schedule, { passive: true, capture: true });
  addEventListener('resize', schedule, { passive: true });
  document.addEventListener('focusin', onFocus);

  return {
    render(targets) {
      swatches = targets
        .filter((t) => t.kind === 'swatch' && t.colour_name)
        .map((target) => ({ target, el: resolve(target.id) }))
        .filter((s): s is { target: ActionTarget; el: Element } => s.el !== null)
        .map(({ target, el }) => {
          const tag = document.createElement('span');
          tag.className = 'asl-colour-label';
          tag.textContent = target.colour_name!;
          return { target, el, tag };
        });
      layer.replaceChildren(...swatches.map((s) => s.tag));
      position();
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      removeEventListener('scroll', schedule, { capture: true });
      removeEventListener('resize', schedule);
      document.removeEventListener('focusin', onFocus);
      layer.remove();
    },
  };
}
