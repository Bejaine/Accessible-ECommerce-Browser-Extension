import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionTarget } from '@shared/index';
import turnRequest from '../../fixtures/mocks/TurnRequest.json';
import { resolveMode } from '../src/core/composer';
import { defaultProfile } from '../src/core/profile';
import { initAnnouncer, resetAnnouncer } from '../src/ui/announce';
import { createControls } from '../src/ui/controls';

const targets = turnRequest.page.targets as ActionTarget[];
const space = () =>
  new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });

describe('overlay controls', () => {
  let container: HTMLElement;
  let now = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    container = document.createElement('div');
    document.body.appendChild(container);
    initAnnouncer(document.body);
  });

  afterEach(() => {
    resetAnnouncer();
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function make(auditory = false) {
    const onPhrase = vi.fn();
    const onSelectTarget = vi.fn();
    const controls = createControls({
      container,
      mode: resolveMode(defaultProfile()),
      switchKey: 'Space',
      auditory,
      onPhrase,
      onSelectTarget,
    });
    return { controls, onPhrase, onSelectTarget };
  }

  it('leaves Space alone on the page unless scanning is running', () => {
    const { controls } = make();
    const before = space();
    document.body.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);

    controls.startScanning(targets);
    const during = space();
    document.body.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(true);

    controls.stopScanning();
    const after = space();
    document.body.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    expect(container.querySelector<HTMLElement>('.asl-scanbar')!.hidden).toBe(true);
  });

  it('switch presses walk zones then items and hand the chosen target over', () => {
    const { controls, onSelectTarget } = make();
    controls.showPhrases('product');
    controls.startScanning(targets);
    const item = () => container.querySelector('.asl-scan-item')!.textContent;
    expect(item()).toBe('Search');
    vi.advanceTimersByTime(1500);
    expect(item()).toBe('Product');
    document.body.dispatchEvent(space());
    expect(item()).toBe('Midnight Black');
    vi.advanceTimersByTime(1500 * 3);
    expect(item()).toBe('Add to Cart');
    now = 1000;
    document.body.dispatchEvent(space());
    expect(onSelectTarget).toHaveBeenCalledWith(expect.objectContaining({ id: 't-add-to-cart' }));
  });

  it('phrases are scannable too, and the tap button acts as the switch', () => {
    const { controls, onPhrase } = make();
    controls.showPhrases('confirm');
    controls.startScanning([]);
    // Only the phrase group: single-group scanning starts on its items.
    expect(container.querySelector('.asl-scan-item')!.textContent).toBe('Yes');
    container.querySelector<HTMLButtonElement>('.asl-scan-choose')!.click();
    expect(onPhrase).toHaveBeenCalledWith({ id: 'yes', text: 'Yes' });
  });

  it('speaks highlights only in auditory mode', () => {
    const quiet = make(false);
    quiet.controls.startScanning(targets);
    vi.advanceTimersByTime(100);
    expect(document.getElementById('asl-live')!.textContent).toBe('');
    quiet.controls.stopScanning();

    const spoken = make(true);
    spoken.controls.startScanning(targets);
    vi.advanceTimersByTime(100);
    expect(document.getElementById('asl-live')!.textContent).toBe('Search');
    spoken.controls.stopScanning();
  });
});
