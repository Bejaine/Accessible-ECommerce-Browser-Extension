// Overlay shell, mounted inside a shadow root by the content script.
// Our own view only: we never hide or restyle the shop's content (rule 11).
import { initAnnouncer } from './announce';

export const OVERLAY_CSS = `
:host { all: initial; }
.asl-overlay {
  position: fixed; inset-block-end: 16px; inset-inline-end: 16px; z-index: 2147483647;
  font: 16px/1.5 system-ui, sans-serif; color: #111; background: #fff;
  border: 2px solid #111; border-radius: 8px; padding: 12px; max-inline-size: 360px;
}
.asl-overlay h2 { font-size: 1.125rem; margin: 0 0 8px; }
.asl-visually-hidden {
  position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
@media (prefers-contrast: more) { .asl-overlay { border-width: 3px; } }
`;

export function mountOverlay(container: HTMLElement): HTMLElement {
  const style = document.createElement('style');
  style.textContent = OVERLAY_CSS;
  container.appendChild(style);

  const region = document.createElement('section');
  region.className = 'asl-overlay';
  region.setAttribute('role', 'region');
  region.setAttribute('aria-labelledby', 'asl-title');

  const heading = document.createElement('h2');
  heading.id = 'asl-title';
  heading.textContent = 'Shopping assistant';
  region.appendChild(heading);

  container.appendChild(region);
  initAnnouncer(container);
  return region;
}
