// Space to speak, simple mode applying its accommodations by itself, and the note that says
// which accessibility features are on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ASRResponse, PageContext } from '@shared/index';
import turnRequest from '../../fixtures/mocks/TurnRequest.json';
import type { Mic, Utterance } from '../src/audio/mic';
import { HOLD_MS, mountApp, SIMPLE_TEXT_SCALE, type App } from '../src/core/app';
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
  /** What the user says before the mic stops (null = silence). */
  let speech: string | null = null;
  const utterance = (said: boolean) =>
    ({
      reason: said ? 'stopped' : 'no_speech',
      wav: new Uint8Array(),
      audioBase64: said ? 'UklGRg==' : '',
      durationMs: said ? 900 : 0,
      micLevel: said ? 0.5 : 0,
    }) as unknown as Utterance;
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
      const r = release;
      release = null;
      r?.(utterance(speech !== null));
    },
    mute: () => undefined,
    unmute: () => undefined,
  };
  return {
    mic,
    calls,
    say(text: string | null) {
      speech = text;
    },
    get heard() {
      return speech;
    },
  };
}

describe('Space, simple mode and the features note', () => {
  let host: HTMLElement;
  let app: App;
  let store: ProfileStore;
  let mic: ReturnType<typeof fakeMic>;
  let rec: ReturnType<typeof recordingSpeaker>;

  const root = () => host.shadowRoot!;
  const key = (type: 'keydown' | 'keyup', target: EventTarget = document.body, extra = {}) => {
    const e = new KeyboardEvent(type, {
      code: 'Space',
      key: ' ',
      bubbles: true,
      cancelable: true,
      composed: true,
      ...extra,
    });
    target.dispatchEvent(e);
    return e;
  };
  /** A quick press and release. */
  const tap = (target: EventTarget = document.body) => {
    const down = key('keydown', target);
    key('keyup', target);
    return down;
  };
  /** Press and keep holding past the hold time. */
  const hold = async (target: EventTarget = document.body) => {
    const down = key('keydown', target);
    await vi.advanceTimersByTimeAsync(HOLD_MS + 10);
    return down;
  };
  const release = async (target: EventTarget = document.body) => {
    key('keyup', target);
    await vi.advanceTimersByTimeAsync(50);
  };

  function mount(devicePrefs: DevicePrefs = { assistantVoice: 'auto' }) {
    (app as App | undefined)?.unmount();
    const container = document.createElement('div');
    root().replaceChildren(container);
    mic = fakeMic();
    rec = recordingSpeaker();
    const base = createMockBackend();
    const backend = {
      ...base,
      asr: async (): Promise<ASRResponse> => ({
        schema_version: '1.0',
        text: mic.heard ?? '',
        lang: 'en',
        asr_meta: { confidence: null, mic_level: null, alternatives: [] },
      }),
    };
    app = mountApp(container, store, createBus(), backend, {
      speaker: rec.speaker,
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

  describe('Space: hold to talk, tap for its usual job', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
    afterEach(() => vi.useRealTimers());

    it('a tap on the page starts hands-free listening; another tap stops it', () => {
      expect(tap().defaultPrevented).toBe(true); // no page scroll
      expect(mic.calls).toEqual(['listen']);
      tap();
      expect(mic.calls).toEqual(['listen', 'stop']);
    });

    it('holding pauses the reading and listens until release; nothing heard -> reading resumes', async () => {
      rec.speaker.say('A long answer', 'en');
      await hold();
      expect(rec.calls).toContain('pause');
      expect(mic.calls).toEqual(['listen']);
      await release();
      expect(mic.calls).toEqual(['listen', 'stop']);
      await vi.waitFor(() => expect(rec.calls.at(-1)).toBe('resume'));
    });

    it('"next" said while holding moves on in what is being read (no server call)', async () => {
      const turn = vi.spyOn(app.turn, 'send');
      rec.speaker.say('A long answer', 'en');
      await hold();
      mic.say('next');
      await release();
      await vi.waitFor(() => expect(rec.calls).toContain('nextSection'));
      expect(turn).not.toHaveBeenCalled();
    });

    it('"read aloud" by voice reads the answer; a voice request is answered aloud', async () => {
      await hold();
      mic.say('what is the price');
      await release();
      // The user spoke, so the answer is read aloud by itself (no Read aloud press needed).
      await vi.waitFor(() => expect(rec.calls).toContain('speakOutput'));
      rec.speaker.stop();
      const before = rec.calls.filter((c) => c === 'speakOutput').length;
      await hold();
      mic.say('read aloud');
      await release();
      await vi.waitFor(() =>
        expect(rec.calls.filter((c) => c === 'speakOutput').length).toBe(before + 1),
      );
    });

    it('a tap on a focused button presses it; holding on it talks instead', async () => {
      const button = document.createElement('button');
      const click = vi.fn();
      button.addEventListener('click', click);
      document.body.append(button);
      tap(button);
      expect(click).toHaveBeenCalledOnce();
      expect(mic.calls).toEqual([]);
      await hold(button);
      await release(button);
      expect(click).toHaveBeenCalledOnce();
      expect(mic.calls).toEqual(['listen', 'stop']);
      button.remove();
    });

    it('typing and Shift+Space are left alone', () => {
      const input = document.createElement('input');
      document.body.append(input);
      expect(tap(input).defaultPrevented).toBe(false);
      expect(tap(root().querySelector('.asl-type input')!).defaultPrevented).toBe(false);
      expect(key('keydown', document.body, { shiftKey: true }).defaultPrevented).toBe(false);
      expect(mic.calls).toEqual([]);
      input.remove();
    });

    it('during switch scanning Space stays the switch', async () => {
      app.controls.startScanning(currentPage.targets);
      await hold();
      await release();
      expect(mic.calls).toEqual([]);
      app.controls.stopScanning();
    });

    it('can be turned off in Settings', () => {
      mount({ assistantVoice: 'auto', spaceToSpeak: false });
      expect(tap().defaultPrevented).toBe(false);
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
