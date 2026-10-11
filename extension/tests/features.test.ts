// Space to speak, simple mode applying its accommodations by itself, and the note that says
// which accessibility features are on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { PageContext } from '@shared/index';
import turnRequest from '../../fixtures/mocks/TurnRequest.json';
import type { Mic, Utterance } from '../src/audio/mic';
import { mountApp, SIMPLE_TEXT_SCALE, type App } from '../src/core/app';
import { createMockBackend } from '../src/core/backend';
import { createBus } from '../src/core/bus';
import { setConditionActive } from '../src/core/composer';
import { createProfileStore, type DevicePrefs, type ProfileStore } from '../src/core/profile';
import { recordingSpeaker } from './helpers/fakeSpeaker';

let currentPage: PageContext;
vi.mock('../src/extract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/extract')>()),
  extractPageContext: vi.fn(() => currentPage),
}));

function fakeMic() {
  const calls: string[] = [];
  let release: ((u: Utterance) => void) | null = null;
  const mic: Mic = {
    get listening() {
      return release !== null;
    },
    muted: false,
    listen: () => {
      calls.push('listen');
      return new Promise<Utterance>((r) => (release = r));
    },
    stop: () => {
      calls.push('stop');
      release?.({
        reason: 'stopped',
        wav: new Uint8Array(),
        audioBase64: '',
        durationMs: 0,
        micLevel: 0,
      } as unknown as Utterance);
      release = null;
    },
    mute: () => undefined,
    unmute: () => undefined,
  };
  return { mic, calls };
}

describe('Space, simple mode and the features note', () => {
  let host: HTMLElement;
  let app: App;
  let store: ProfileStore;
  let mic: ReturnType<typeof fakeMic>;

  const root = () => host.shadowRoot!;
  const space = (target: EventTarget = document.body) => {
    const e = new KeyboardEvent('keydown', {
      code: 'Space',
      key: ' ',
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    target.dispatchEvent(e);
    return e;
  };

  function mount(devicePrefs: DevicePrefs = { assistantVoice: 'auto' }) {
    (app as App | undefined)?.unmount();
    const container = document.createElement('div');
    root().replaceChildren(container);
    mic = fakeMic();
    app = mountApp(container, store, createBus(), createMockBackend(), {
      speaker: recordingSpeaker().speaker,
      mic: mic.mic,
      devicePrefs,
    });
  }

  beforeEach(async () => {
    fakeBrowser.reset();
    sessionStorage.clear();
    currentPage = structuredClone(turnRequest.page) as unknown as PageContext;
    host = document.createElement('div');
    host.attachShadow({ mode: 'open' });
    document.body.append(host);
    store = await createProfileStore();
    mount();
  });
  afterEach(() => {
    app.unmount();
    host.remove();
  });

  describe('Space to speak', () => {
    it('Space on the page starts listening, and again stops it', () => {
      const e = space();
      expect(e.defaultPrevented).toBe(true);
      expect(mic.calls).toEqual(['listen']);
      space();
      expect(mic.calls).toEqual(['listen', 'stop']);
    });

    it('typing, a focused button, and other keys keep Space as it is', () => {
      const input = document.createElement('input');
      const button = document.createElement('button');
      const a = document.createElement('a');
      a.href = '#x';
      document.body.append(input, button, a);
      for (const el of [input, button, a]) expect(space(el).defaultPrevented).toBe(false);
      // Our own typing box too.
      expect(space(root().querySelector('.asl-type input')!).defaultPrevented).toBe(false);
      const shifted = new KeyboardEvent('keydown', {
        code: 'Space',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(shifted);
      expect(shifted.defaultPrevented).toBe(false);
      expect(mic.calls).toEqual([]);
      input.remove();
      button.remove();
      a.remove();
    });

    it('during switch scanning Space stays the switch', () => {
      app.controls.startScanning(currentPage.targets);
      space();
      expect(mic.calls).toEqual([]);
      app.controls.stopScanning();
    });

    it('can be turned off in Settings', () => {
      mount({ assistantVoice: 'auto', spaceToSpeak: false });
      expect(space().defaultPrevented).toBe(false);
      expect(mic.calls).toEqual([]);
    });
  });

  describe('simple mode applies its accommodations by itself', () => {
    it('turning it on enlarges text and opens the simple view (without moving focus)', async () => {
      const before = document.activeElement;
      await store.update((d) => setConditionActive(d, 'ageing', true, 'inferred', 0.8));
      await vi.waitFor(() => expect(store.get().prefs.text_scale).toBe(SIMPLE_TEXT_SCALE));
      expect(app.overlay.isOpen).toBe(true);
      expect(root().querySelector('.asl-simple')).not.toBeNull();
      expect(document.activeElement).toBe(before);
      // Undo puts the text size back.
      await store.update((d) => setConditionActive(d, 'ageing', false, 'inferred', 0));
      await vi.waitFor(() => expect(store.get().prefs.text_scale).toBe(1));
    });

    it('a page loaded in simple mode opens into the simple view; other pages stay closed', async () => {
      // Simple mode set before this page loaded (e.g. at setup): applied on load, once.
      app.unmount();
      await store.update((d) => setConditionActive(d, 'ageing', true, 'user', 1));
      mount();
      await vi.waitFor(() => expect(store.get().prefs.text_scale).toBe(SIMPLE_TEXT_SCALE));
      expect(app.overlay.isOpen).toBe(true);
      expect(root().querySelector('.asl-simple')).not.toBeNull();
      currentPage = { ...currentPage, page_type: 'search', products: [] };
      mount();
      expect(app.overlay.isOpen).toBe(false);
    });

    it('a text size the user chose larger is kept', async () => {
      await store.update((d) => {
        d.prefs.text_scale = 2;
      });
      await store.update((d) => setConditionActive(d, 'ageing', true, 'user', 1));
      await new Promise((r) => setTimeout(r, 0));
      expect(store.get().prefs.text_scale).toBe(2);
    });
  });

  describe('the features note', () => {
    const note = () => root().querySelector<HTMLElement>('.asl-active')!;

    it('lists features on by their names (never conditions) and says which were automatic', async () => {
      expect(note().hidden).toBe(true); // nothing on
      await store.update((d) => setConditionActive(d, 'visual', true, 'user', 1));
      await store.update((d) => setConditionActive(d, 'motor', true, 'inferred', 0.8));
      expect(note().hidden).toBe(false);
      expect(note().getAttribute('aria-label')).toBe('Accessibility features on');
      expect([...note().querySelectorAll('li')].map((li) => li.textContent)).toEqual([
        'Read-aloud mode',
        'Easy-press mode (turned on automatically)',
      ]);
      expect(note().textContent).not.toMatch(/blind|disab|impair|elder|old|tremor|patient/i);
    });

    it('Change opens Settings; Hide hides it until the features change', async () => {
      await store.update((d) => setConditionActive(d, 'visual', true, 'user', 1));
      const [change, hide] = [...note().querySelectorAll('button')];
      expect(hide!.getAttribute('aria-label')).toBe('Hide this note');
      change!.click();
      expect(root().querySelector('.asl-content .asl-settings')).not.toBeNull();
      hide!.click();
      expect(note().hidden).toBe(true);
      await store.update((d) => setConditionActive(d, 'colour', true, 'user', 1));
      expect(note().hidden).toBe(false);
    });
  });
});

describe('simple view spec values', () => {
  it('true / false read as Yes / No', async () => {
    const { specValue } = await import('../src/ui/simpleView');
    expect([specValue(true), specValue('false'), specValue(5)]).toEqual(['Yes', 'No', '5']);
  });
});

describe('product prepare carries the shopping session', () => {
  it('sends the same session id as turns (Track C compares products opened earlier)', async () => {
    fakeBrowser.reset();
    currentPage = structuredClone(turnRequest.page) as unknown as PageContext;
    const store = await createProfileStore();
    const backend = createMockBackend();
    const prepare = vi.spyOn(backend, 'prepareProduct');
    const host = document.createElement('div');
    document.body.append(host);
    const app = mountApp(host, store, createBus(), backend, {
      speaker: recordingSpeaker().speaker,
      sessionId: 'session-42',
    });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
    expect(prepare.mock.calls[0]![0].session_id).toBe('session-42');
    app.unmount();
    host.remove();
  });
});
