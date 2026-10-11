// Overlay shell, mounted inside a shadow root by the content script.
// Our own view only: we never hide or restyle the shop's content (rule 11).
//
// Starts collapsed to a single toggle button: nothing pops up on page load. Opening moves focus
// to the panel heading; Escape or the close button collapses it and returns focus to the toggle.
// Renderers mount into `overlay.content`; phrase board and scan bar into `overlay.controls`.
import { RENDER_CSS } from '../render/visual';
import { SCAN_BAR_CSS } from './scanBar';
import { SUGGESTION_CSS } from './suggestionCard';
import { CONFIRM_CSS } from './confirmCard';
import { MIC_CSS } from './micButton';
import { SETTINGS_CSS } from './settings';
import { ACTION_MENU_CSS } from './actionMenu';
import { COLOUR_LABEL_CSS } from './colourLabels';
import { SIMPLE_VIEW_CSS } from './simpleView';
import { PLAYBACK_CSS } from './playbackBar';
import { DWELL_CSS } from './dwell';
import { CHECKOUT_CSS } from './checkoutWizard';
import { MENU_CSS } from './menu';
import { initAnnouncer } from './announce';
import { label } from './strings';

export const MIN_TEXT_SCALE = 1;
export const MAX_TEXT_SCALE = 3;

export const OVERLAY_CSS = `
:host { all: initial; }
.asl-root {
  --asl-scale: 1;
  --asl-bg: #ffffff; --asl-fg: #111111; --asl-muted: #444444;
  --asl-accent: #0b57d0; --asl-accent-fg: #ffffff; --asl-border: #111111;
  --asl-line: #d6d6d6; --asl-line-strong: #6b6b6b; --asl-tile: #f4f5f7;
  font: calc(16px * var(--asl-scale)) / 1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: var(--asl-fg);
}
@media (prefers-color-scheme: dark) {
  .asl-root {
    --asl-bg: #1b1b1f; --asl-fg: #f2f2f2; --asl-muted: #c8c8c8;
    --asl-accent: #8ab4f8; --asl-accent-fg: #111111; --asl-border: #f2f2f2;
    --asl-line: #3c3c43; --asl-line-strong: #9a9aa3; --asl-tile: #26262c;
  }
}
.asl-toggle, .asl-panel {
  position: fixed; inset-block-end: 16px; inset-inline-end: 16px; z-index: 2147483647;
}
.asl-toggle, .asl-close {
  min-inline-size: 44px; min-block-size: 44px; padding: 8px 16px; cursor: pointer;
  font: inherit; font-weight: 600; border-radius: 8px;
  color: var(--asl-accent-fg); background: var(--asl-accent); border: 2px solid var(--asl-border);
}
.asl-panel {
  box-sizing: border-box; inline-size: min(400px, calc(100vw - 32px));
  max-block-size: calc(100vh - 32px); overflow: auto;
  background: var(--asl-bg); color: var(--asl-fg);
  border: 2px solid var(--asl-border); border-radius: 12px; padding: 12px 16px 16px;
  box-shadow: 0 4px 24px rgb(0 0 0 / 0.3);
}
.asl-panel[hidden], .asl-toggle[hidden] { display: none; }
.asl-panel.asl-wide { inline-size: min(720px, calc(100vw - 32px)); }
.asl-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.asl-header h2 { font-size: 1.125em; margin: 0; }
.asl-header h2:focus { outline: none; }
.asl-header h2:focus-visible { outline: 3px solid var(--asl-accent); outline-offset: 2px; }
.asl-close { padding: 0 12px; }
.asl-content { margin-block-start: 12px; }
button:focus-visible { outline: 3px solid var(--asl-fg); outline-offset: 3px; }
.asl-visually-hidden {
  position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap;
}
@media (max-width: 480px) {
  .asl-panel { inset-inline: 8px; inset-block-end: 8px; inline-size: auto; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}
@media (prefers-contrast: more) {
  .asl-root { --asl-muted: var(--asl-fg); --asl-line: var(--asl-fg); --asl-line-strong: var(--asl-fg); }
  .asl-panel, .asl-toggle, .asl-close { border-width: 3px; }
}
@media (forced-colors: active) {
  /* Every button in system colours: accent fills would otherwise keep only their text colour.
     !important because each component's own button rules are more specific. */
  .asl-root button { color: ButtonText !important; background-color: ButtonFace !important;
    border-color: ButtonText !important; }
  .asl-root button[aria-pressed='true'] { color: HighlightText !important;
    background-color: Highlight !important; }
  .asl-panel { background: Canvas; color: CanvasText; border-color: CanvasText; }
  .asl-toggle, .asl-close { background: ButtonFace; color: ButtonText; border-color: ButtonText; }
  button:focus-visible { outline-color: Highlight; }
}
`;

export interface Overlay {
  /** Where renderers mount AccessibleOutput views. */
  readonly content: HTMLElement;
  /** Phrase board and scan bar. */
  readonly controls: HTMLElement;
  /** Themed root outside the panel, for floating UI (playback bar) that stays visible when closed. */
  readonly floating: HTMLElement;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** Clamped to 1-3 (Prefs.text_scale). */
  setTextScale(scale: number): void;
  /** Extra word on the collapsed toggle, e.g. "suggestion"; null clears it. */
  setBadge(text: string | null): void;
  /** Remove the overlay entirely (e.g. before remounting in another language). */
  destroy(): void;
  /** Wider panel for the simplified product view. */
  setWide(wide: boolean): void;
  /** Called whenever the panel opens (e.g. to refresh the page map). */
  onOpen(listener: () => void): () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountOverlay(container: HTMLElement, lang?: string): Overlay {
  const style = el('style');
  style.textContent =
    OVERLAY_CSS +
    RENDER_CSS +
    SCAN_BAR_CSS +
    SUGGESTION_CSS +
    CONFIRM_CSS +
    MIC_CSS +
    SETTINGS_CSS +
    ACTION_MENU_CSS +
    COLOUR_LABEL_CSS +
    SIMPLE_VIEW_CSS +
    PLAYBACK_CSS +
    DWELL_CSS +
    CHECKOUT_CSS +
    MENU_CSS;

  const root = el('div', { class: 'asl-root' });

  const toggleBtn = el(
    'button',
    { type: 'button', class: 'asl-toggle', 'aria-expanded': 'false', 'aria-controls': 'asl-panel' },
    label('overlay.title', lang),
  );

  const panel = el('section', {
    id: 'asl-panel',
    class: 'asl-panel',
    role: 'region',
    'aria-labelledby': 'asl-title',
  });
  panel.hidden = true;

  const header = el('div', { class: 'asl-header' });
  const heading = el('h2', { id: 'asl-title', tabindex: '-1' }, label('overlay.title', lang));
  const closeBtn = el('button', {
    type: 'button',
    class: 'asl-close',
    'aria-label': label('overlay.close', lang),
  });
  closeBtn.append(el('span', { 'aria-hidden': 'true' }, '×'));
  header.append(heading, closeBtn);

  const content = el('div', { id: 'asl-content', class: 'asl-content' });
  const controls = el('div', { id: 'asl-controls', class: 'asl-controls' });
  panel.append(header, content, controls);
  root.append(toggleBtn, panel);
  container.append(style, root);
  initAnnouncer(root);

  let isOpen = false;
  const openListeners = new Set<() => void>();

  function open(): void {
    if (isOpen) return;
    isOpen = true;
    panel.hidden = false;
    toggleBtn.hidden = true;
    toggleBtn.setAttribute('aria-expanded', 'true');
    heading.focus();
    openListeners.forEach((l) => l());
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    panel.hidden = true;
    toggleBtn.hidden = false;
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.focus();
  }

  toggleBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });

  return {
    content,
    controls,
    floating: root,
    get isOpen() {
      return isOpen;
    },
    open,
    close,
    toggle: () => (isOpen ? close() : open()),
    setWide(wide) {
      panel.classList.toggle('asl-wide', wide);
    },
    onOpen(listener) {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
    destroy() {
      style.remove();
      root.remove();
    },
    setBadge(text) {
      const title = label('overlay.title', lang);
      toggleBtn.textContent = text ? `${title} (${text})` : title;
    },
    setTextScale(scale) {
      const clamped = Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, scale));
      root.style.setProperty('--asl-scale', String(clamped));
    },
  };
}
