// Button audit: mount the real app, bring it into each state, click EVERY button there, and
// require an observable effect (DOM change, announcement, speech, saved setting, bus message,
// focus move, or scanner step). A button that does nothing fails with its name and state.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ActionTarget, Lang } from '@shared/index';
import turnRequest from '../../fixtures/mocks/TurnRequest.json';
import type { Mic, Utterance } from '../src/audio/mic';
import { mountApp, type App } from '../src/core/app';
import { createMockBackend } from '../src/core/backend';
import { createBus } from '../src/core/bus';
import { createProfileStore, type ProfileStore } from '../src/core/profile';
import { recordingSpeaker } from './helpers/fakeSpeaker';

vi.mock('../src/actuate', () => ({
  performAction: vi.fn(async () => ({ ok: false, reason: 'not implemented' })),
}));

const targets = turnRequest.page.targets as ActionTarget[];

function fakeMic(): Mic {
  const utterance: Utterance = {
    reason: 'silence',
    wav: new Uint8Array(2),
    audioBase64: 'UklGRg==',
    durationMs: 900,
    micLevel: 0.5,
  };
  return {
    listening: false,
    muted: false,
    listen: async () => utterance,
    stop: () => undefined,
    mute: () => undefined,
    unmute: () => undefined,
  };
}

type State = 'start' | 'answer' | 'confirmation' | 'suggestion' | 'settings' | 'scanning';
const STATES: State[] = ['start', 'answer', 'confirmation', 'suggestion', 'settings', 'scanning'];

describe('every button does something, in every state', () => {
  let host: HTMLElement;
  let app: App;
  let store: ProfileStore;
  let effects: string[];
  let observer: MutationObserver;
  let calls: string[];

  async function mountIn(state: State, opts: { demo?: boolean } = {}) {
    fakeBrowser.reset();
    host?.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    const container = document.createElement('div');
    host.attachShadow({ mode: 'open' }).appendChild(container);
    store = await createProfileStore();
    const bus = createBus();
    const emit = bus.emit.bind(bus);
    bus.emit = (m) => {
      effects.push(`bus:${m.type}`);
      emit(m);
    };
    const rec = recordingSpeaker();
    calls = rec.calls;
    app = mountApp(container, store, bus, createMockBackend(), {
      mic: fakeMic(),
      speaker: rec.speaker,
      demo: opts.demo ?? false,
    });
    app.overlay.open();

    if (state === 'answer') {
      bus.emit({ type: 'phrase', id: 'reviews', text: 'What do reviews say?' });
      await vi.waitFor(() => expect(host.shadowRoot!.querySelector('.asl-output')).not.toBeNull());
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
    } else if (state === 'scanning') {
      app.controls.startScanning(targets);
    }
    await vi.advanceTimersByTimeAsync(200);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    effects = [];
  });

  afterEach(() => {
    observer?.disconnect();
    app?.unmount();
    host?.remove();
    vi.useRealTimers();
  });

  const visibleButtons = () =>
    [...host.shadowRoot!.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => !b.closest('[hidden]') && !b.hidden,
    );

  for (const state of STATES) {
    it(`state "${state}": each visible button has an effect`, async () => {
      await mountIn(state);
      const names = visibleButtons().map((b) => b.textContent ?? '');
      if (process.env.AUDIT_LIST) console.log(`[audit] ${state}: ${names.join(' | ')}`);
      expect(names.length).toBeGreaterThan(0);
      const dead: string[] = [];

      for (let i = 0; i < names.length; i++) {
        await mountIn(state); // fresh app for each button, so one click can't hide another
        const button = visibleButtons()[i];
        if (!button) continue;
        effects = [];
        calls.length = 0;
        const before = store.get();
        observer = new MutationObserver(() => effects.push('dom'));
        observer.observe(host.shadowRoot!, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        const focusBefore = host.shadowRoot!.activeElement;
        button.click();
        await vi.advanceTimersByTimeAsync(200);
        observer.disconnect();
        const changed =
          effects.length > 0 ||
          calls.length > 0 ||
          store.get() !== before ||
          host.shadowRoot!.activeElement !== focusBefore;
        if (!changed) dead.push(names[i]!);
      }
      expect(dead, `buttons with no effect in state "${state}"`).toEqual([]);
    });
  }

  it('Speak in demo mode says honestly that voice needs the language service', async () => {
    await mountIn('start', { demo: true });
    host.shadowRoot!.querySelector<HTMLButtonElement>('.asl-mic')!.click();
    await vi.advanceTimersByTimeAsync(200);
    expect(host.shadowRoot!.getElementById('asl-live')!.textContent).toContain(
      'Voice input needs the language service',
    );
  });

  it('Back to menu closes the answer, stops reading, and returns focus to the menu', async () => {
    await mountIn('answer');
    const back = visibleButtons().find((b) => b.textContent === 'Back to menu')!;
    back.click();
    expect(host.shadowRoot!.querySelector('.asl-output')).toBeNull();
    expect(calls).toContain('stop');
    expect(host.shadowRoot!.activeElement?.className).toBe('asl-mic');
  });

  it('Read aloud reads the whole answer; Stop reading stops it', async () => {
    await mountIn('answer');
    const read = () =>
      visibleButtons().find((b) => /Read aloud|Stop reading/.test(b.textContent ?? ''))!;
    read().click();
    expect(calls).toContain('speakOutput');
    expect(read().textContent).toBe('Stop reading');
    read().click();
    expect(calls.at(-1)).toBe('stop');
    expect(read().textContent).toBe('Read aloud');
  });

  it('Slower / Faster change the voice speed immediately', async () => {
    await mountIn('start');
    visibleButtons()
      .find((b) => b.textContent === 'Slower')!
      .click();
    await vi.waitFor(() => expect(calls).toContain('rate:0.75'));
    visibleButtons()
      .find((b) => b.textContent === 'Faster')!
      .click();
    await vi.waitFor(() => expect(calls).toContain('rate:1'));
  });

  it('with read-aloud on, answers and prompts are spoken by the assistant itself', async () => {
    await mountIn('start');
    host.shadowRoot!.querySelector<HTMLButtonElement>('.asl-settings-toggle')!.click();
    const readAloudBox = [...host.shadowRoot!.querySelectorAll('fieldset label')][0]!.querySelector(
      'input',
    )!;
    readAloudBox.click();
    await vi.waitFor(() => expect(store.get().conditions.visual.active).toBe(true));
    calls.length = 0;
    host.shadowRoot!.querySelectorAll<HTMLButtonElement>('.asl-phrases button')[0]!.click();
    await vi.waitFor(() =>
      expect(
        calls.some((c) => c === 'speakOutput' || c.startsWith('say:') || c.startsWith('prompt:')),
      ).toBe(true),
    );
  });

  it('the keyboard shortcut toggles the assistant and speaks an orientation', async () => {
    await mountIn('start');
    app.overlay.close();
    app.toggleAssistant();
    expect(app.overlay.isOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.shadowRoot!.getElementById('asl-live')!.textContent).toContain('Alt+Shift+A');
    app.toggleAssistant();
    expect(app.overlay.isOpen).toBe(false);
  });

  it('the interface follows the chosen language', async () => {
    fakeBrowser.reset();
    const s = await createProfileStore();
    await s.update((d) => {
      d.prefs.lang = 'hi' as Lang;
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    const container = document.createElement('div');
    host.attachShadow({ mode: 'open' }).appendChild(container);
    app = mountApp(container, s, createBus(), createMockBackend(), {
      mic: fakeMic(),
      speaker: recordingSpeaker().speaker,
    });
    expect(host.shadowRoot!.querySelector('.asl-toggle')?.textContent).toBe('शॉपिंग सहायक');
    expect(host.shadowRoot!.querySelector('.asl-mic')?.textContent).toBe('बोलें');
    expect(host.shadowRoot!.querySelector('.asl-settings-toggle')?.textContent).toBe('सेटिंग्स');
  });
});
