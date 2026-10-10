// Automated accessibility check (axe-core) of the real overlay in every state. Colour contrast
// needs real layout and rendering, so it is checked in the browser, not here.
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ActionTarget } from '@shared/index';
import turnRequest from '../../fixtures/mocks/TurnRequest.json';
import type { Mic } from '../src/audio/mic';
import { mountApp, type App } from '../src/core/app';
import { createMockBackend } from '../src/core/backend';
import { createBus } from '../src/core/bus';
import { createProfileStore } from '../src/core/profile';
import { recordingSpeaker } from './helpers/fakeSpeaker';

vi.mock('../src/actuate', () => ({
  performAction: vi.fn(async () => ({ ok: false, reason: 'not implemented' })),
}));

const targets = turnRequest.page.targets as ActionTarget[];
type State =
  'start' | 'answer' | 'confirmation' | 'suggestion' | 'settings' | 'scanning' | 'playing';

describe('axe-core: no accessibility violations in any overlay state', () => {
  let host: HTMLElement;
  let app: App;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  });
  afterEach(() => {
    app?.unmount();
    host?.remove();
    vi.useRealTimers();
  });

  async function mountIn(state: State) {
    fakeBrowser.reset();
    host = document.createElement('div');
    document.body.appendChild(host);
    const container = document.createElement('div');
    host.attachShadow({ mode: 'open' }).appendChild(container);
    const store = await createProfileStore();
    const bus = createBus();
    const mic = {
      listening: false,
      muted: false,
      listen: () => new Promise(() => undefined),
      stop: () => undefined,
      mute: () => undefined,
      unmute: () => undefined,
    } as unknown as Mic;
    app = mountApp(container, store, bus, createMockBackend(), {
      mic,
      speaker: recordingSpeaker().speaker,
    });
    app.overlay.open();
    if (state === 'answer' || state === 'playing') {
      bus.emit({ type: 'phrase', id: 'reviews', text: 'What do reviews say?' });
      await vi.waitFor(() => expect(host.shadowRoot!.querySelector('.asl-output')).not.toBeNull());
      if (state === 'playing')
        host.shadowRoot!.querySelector<HTMLButtonElement>('.asl-toolbar button')!.click();
    } else if (state === 'confirmation') {
      bus.emit({ type: 'phrase', id: 'add_to_cart', text: 'Add to cart' });
      await vi.waitFor(() => expect(app.turn.pending).not.toBeNull());
    } else if (state === 'suggestion') {
      for (let i = 0; i < 10; i++) {
        app.engine.add('repeat_click');
        app.engine.add('near_miss');
      }
      app.suggester.check();
    } else if (state === 'settings') {
      host.shadowRoot!.querySelector<HTMLButtonElement>('.asl-settings-toggle')!.click();
      host.shadowRoot!.querySelector<HTMLButtonElement>('.asl-menu-toggle:not([hidden])')?.click();
    } else if (state === 'scanning') {
      app.controls.startScanning(targets);
    }
  }

  for (const state of [
    'start',
    'answer',
    'confirmation',
    'suggestion',
    'settings',
    'scanning',
    'playing',
  ] as State[]) {
    it(state, { timeout: 30_000 }, async () => {
      await mountIn(state);
      vi.useRealTimers(); // axe schedules its own work with timers
      const result = await axe.run(host, { rules: { 'color-contrast': { enabled: false } } });
      const problems = result.violations.map(
        (v) => `${v.id}: ${v.help} -> ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
      );
      expect(problems).toEqual([]);
    });
  }
});
