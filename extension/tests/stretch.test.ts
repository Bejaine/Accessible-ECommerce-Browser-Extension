// Motor and playback stretch features: adaptive scan speed, dwell to click, resume after a
// page change.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { PlayerSnapshot } from '../src/audio/player';
import { mountApp } from '../src/core/app';
import { createMockBackend } from '../src/core/backend';
import { createBus } from '../src/core/bus';
import { createProfileStore } from '../src/core/profile';
import { createResumeStore, RESUME_KEY, RESUME_MAX_AGE_MS } from '../src/core/resume';
import { attachDwell } from '../src/ui/dwell';
import { createScanner, STEADY_PRESSES, type ScanGroup } from '../src/ui/scanner';
import { recordingSpeaker } from './helpers/fakeSpeaker';

const group = (n: number): ScanGroup => ({
  id: 'g',
  label: 'G',
  items: Array.from({ length: n }, (_, i) => ({ id: `i${i}`, label: `i${i}`, activate: vi.fn() })),
});

describe('adaptive scan speed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const changes: number[] = [];
    const scanner = createScanner({
      intervalMs: 1000,
      backLabel: 'Back',
      pausedLabel: 'Paused',
      adaptive: { maxMs: 5000, onChange: (ms) => changes.push(ms) },
    });
    scanner.start([group(4)]);
    return { scanner, changes };
  }

  it('a press just after the highlight moved slows scanning down (up to the maximum)', () => {
    const { scanner, changes } = setup();
    vi.advanceTimersByTime(1000 + 100); // moved, then pressed 100 ms later: late
    scanner.press();
    expect(scanner.intervalMs).toBe(1200);
    expect(changes).toEqual([1200]);
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(scanner.intervalMs + 50);
      scanner.press();
    }
    expect(scanner.intervalMs).toBe(5000);
  });

  it('unhurried presses speed it back up, never faster than the mode', () => {
    const { scanner } = setup();
    vi.advanceTimersByTime(1050);
    scanner.press(); // late: 1200
    expect(scanner.intervalMs).toBe(1200);
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < STEADY_PRESSES; i++) {
        vi.advanceTimersByTime(scanner.intervalMs + 600); // well after a move
        scanner.press();
      }
    }
    expect(scanner.intervalMs).toBe(1000);
  });

  it('the first press after entering a level is never late; without adaptive nothing changes', () => {
    const { scanner, changes } = setup();
    scanner.press(); // right after start
    expect(changes).toEqual([]);
    const plain = createScanner({ intervalMs: 1000, backLabel: 'Back', pausedLabel: 'P' });
    plain.start([group(3)]);
    vi.advanceTimersByTime(1010);
    plain.press();
    expect(plain.intervalMs).toBe(1000);
  });
});

describe('dwell to click', () => {
  let host: HTMLElement;
  let root: ShadowRoot;
  let button: HTMLButtonElement;
  const onClick = vi.fn();

  const pointer = (
    type: string,
    el: Element,
    pointerType = 'mouse',
    related: Element | null = null,
  ) =>
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        composed: true,
        pointerType,
        relatedTarget: related,
      }),
    );

  beforeEach(() => {
    vi.useFakeTimers();
    onClick.mockReset();
    host = document.createElement('div');
    document.body.append(host);
    root = host.attachShadow({ mode: 'open' });
    button = document.createElement('button');
    button.textContent = 'Add to cart';
    button.addEventListener('click', onClick);
    root.append(button);
  });
  afterEach(() => {
    host.remove();
    vi.useRealTimers();
  });

  it('resting on a control clicks it once; it fires again only after leaving', () => {
    const dwell = attachDwell(root, 1200);
    pointer('pointerover', button);
    expect(button.classList.contains('asl-dwelling')).toBe(true);
    vi.advanceTimersByTime(1199);
    expect(onClick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onClick).toHaveBeenCalledOnce();
    expect(button.classList.contains('asl-dwelling')).toBe(false);

    pointer('pointermove', button); // tremor: still on it
    vi.advanceTimersByTime(3000);
    expect(onClick).toHaveBeenCalledOnce();

    pointer('pointerout', button, 'mouse', document.body);
    pointer('pointerover', button);
    vi.advanceTimersByTime(1200);
    expect(onClick).toHaveBeenCalledTimes(2);
    dwell.detach();
  });

  it('leaving early cancels; touch, disabled controls and plain text are ignored', () => {
    const dwell = attachDwell(root, 1000);
    pointer('pointerover', button);
    vi.advanceTimersByTime(500);
    pointer('pointerout', button, 'mouse', document.body); // straight onto the shop's page
    vi.advanceTimersByTime(2000);
    expect(onClick).not.toHaveBeenCalled();

    pointer('pointerover', button, 'touch');
    vi.advanceTimersByTime(2000);
    expect(onClick).not.toHaveBeenCalled();

    button.disabled = true;
    pointer('pointerover', button);
    vi.advanceTimersByTime(2000);
    expect(onClick).not.toHaveBeenCalled();

    const text = document.createElement('p');
    root.append(text);
    pointer('pointerover', text);
    vi.advanceTimersByTime(2000);
    expect(onClick).not.toHaveBeenCalled();
    dwell.detach();
  });

  it('detach stops it', () => {
    attachDwell(root, 800).detach();
    pointer('pointerover', button);
    vi.advanceTimersByTime(2000);
    expect(onClick).not.toHaveBeenCalled();
  });
});

const snap: PlayerSnapshot = {
  sections: [{ segments: [{ text: 'Rated 4.2 by 1,203 buyers.' }, { text: 'Battery' }] }],
  lang: 'en',
  section: 0,
  index: 1,
};

describe('resume after a page change', () => {
  beforeEach(() => fakeBrowser.reset());

  it('keeps the position on the device and offers it once on the same site', async () => {
    let now = 1_000;
    createResumeStore('www.amazon.in', () => now).save(snap);
    await vi.waitFor(async () =>
      expect((await browser.storage.local.get(RESUME_KEY))[RESUME_KEY]).toBeTruthy(),
    );
    now += 30_000;
    const next = createResumeStore('www.amazon.in', () => now);
    expect(await next.take()).toEqual(snap);
    expect(await next.take()).toBeNull(); // taken once
  });

  it('another site or an old position is not offered; clear removes it', async () => {
    let now = 0;
    const store = createResumeStore('www.amazon.in', () => now);
    store.save(snap);
    await vi.waitFor(async () =>
      expect((await browser.storage.local.get(RESUME_KEY))[RESUME_KEY]).toBeTruthy(),
    );
    expect(await createResumeStore('www.flipkart.com', () => now).take()).toBeNull();

    store.save(snap);
    now = RESUME_MAX_AGE_MS + 1;
    expect(await createResumeStore('www.amazon.in', () => now).take()).toBeNull();

    store.save(snap);
    store.clear();
    await vi.waitFor(async () =>
      expect((await browser.storage.local.get(RESUME_KEY))[RESUME_KEY]).toBeUndefined(),
    );
  });

  it('the app holds a saved answer as paused and says how to resume', async () => {
    await browser.storage.local.set({
      [RESUME_KEY]: { snap, site: location.hostname, saved_at: Date.now() },
    });
    const store = await createProfileStore();
    const host = document.createElement('div');
    document.body.append(host);
    const rec = recordingSpeaker();
    const app = mountApp(host, store, createBus(), createMockBackend(), {
      speaker: rec.speaker,
      demo: true,
    });
    await vi.waitFor(() => expect(rec.calls).toContain('offerResume'));
    expect(rec.speaker.state).toBe('paused');
    const live = host.querySelector('#asl-live') ?? host.shadowRoot?.getElementById('asl-live');
    await vi.waitFor(() => expect(live?.textContent).toMatch(/page changed/));
    app.playbackKey();
    expect(rec.calls).toContain('resume');
    app.unmount();
    host.remove();
  });
});
