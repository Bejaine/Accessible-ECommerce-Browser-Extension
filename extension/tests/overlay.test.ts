import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetAnnouncer } from '../src/ui/announce';
import { mountOverlay, type Overlay } from '../src/ui/overlay';

describe('overlay shell', () => {
  let host: HTMLElement;
  let shadow: ShadowRoot;
  let overlay: Overlay;

  const $ = <T extends Element>(sel: string) => shadow.querySelector<T>(sel)!;
  const toggleBtn = () => $<HTMLButtonElement>('.asl-toggle');
  const panel = () => $<HTMLElement>('#asl-panel');

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    const container = document.createElement('div');
    shadow.appendChild(container);
    overlay = mountOverlay(container);
  });

  afterEach(() => {
    resetAnnouncer();
    host.remove();
  });

  it('starts collapsed: only the toggle is shown and focus is not taken', () => {
    expect(overlay.isOpen).toBe(false);
    expect(panel().hidden).toBe(true);
    expect(toggleBtn().getAttribute('aria-expanded')).toBe('false');
    expect(toggleBtn().getAttribute('aria-controls')).toBe('asl-panel');
    expect(toggleBtn().textContent).toBe('Shopping assistant');
    expect(shadow.activeElement).toBeNull();
  });

  it('is a labelled region with a heading, a named close button and one live region', () => {
    expect(panel().getAttribute('role')).toBe('region');
    expect(panel().getAttribute('aria-labelledby')).toBe('asl-title');
    expect($('#asl-title').tagName).toBe('H2');
    expect($('.asl-close').getAttribute('aria-label')).toBe('Close shopping assistant');
    expect(shadow.querySelectorAll('[aria-live]')).toHaveLength(1);
    expect(overlay.content.id).toBe('asl-content');
  });

  it('opening moves focus to the heading; Escape closes and returns focus to the toggle', () => {
    toggleBtn().click();
    expect(overlay.isOpen).toBe(true);
    expect(panel().hidden).toBe(false);
    expect(shadow.activeElement?.id).toBe('asl-title');

    panel().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(overlay.isOpen).toBe(false);
    expect(shadow.activeElement).toBe(toggleBtn());
  });

  it('the close button collapses the panel', () => {
    overlay.open();
    $<HTMLButtonElement>('.asl-close').click();
    expect(overlay.isOpen).toBe(false);
    expect(toggleBtn().getAttribute('aria-expanded')).toBe('false');
  });

  it('clamps text scale to 1-3', () => {
    const root = $<HTMLElement>('.asl-root');
    overlay.setTextScale(5);
    expect(root.style.getPropertyValue('--asl-scale')).toBe('3');
    overlay.setTextScale(0.5);
    expect(root.style.getPropertyValue('--asl-scale')).toBe('1');
  });
});
