// The dependable device voice (src/core/deviceVoice.ts): Chrome on Linux and Android ignore
// speechSynthesis.pause(), so pause cancels the sentence and resume says it again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { AFTER_CANCEL_MS, deviceVoice } from '../src/core/deviceVoice';
import { mountApp, type App } from '../src/core/app';
import { createMockBackend } from '../src/core/backend';
import { createBus } from '../src/core/bus';
import { createProfileStore, interruptBySpeaking } from '../src/core/profile';
import { recordingSpeaker } from './helpers/fakeSpeaker';

interface FakeUtterance {
  text: string;
  voice: unknown;
  lang: string;
  rate: number;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

function fakeSynth() {
  const spoken: FakeUtterance[] = [];
  let current: FakeUtterance | null = null;
  const synth = {
    speak: (u: SpeechSynthesisUtterance) => {
      current = u as unknown as FakeUtterance;
      spoken.push(current);
    },
    cancel: () => {
      const u = current;
      current = null;
      u?.onerror?.({ error: 'interrupted' });
    },
  };
  const make = (text: string) =>
    ({
      text,
      voice: null,
      lang: '',
      rate: 1,
      onend: null,
      onerror: null,
    }) as unknown as SpeechSynthesisUtterance;
  const end = () => {
    const u = current;
    current = null;
    u?.onend?.();
  };
  return {
    synth,
    make,
    spoken,
    end,
    get current() {
      return current;
    },
  };
}

const voice = { lang: 'en-IN' } as SpeechSynthesisVoice;

describe('device voice', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pause stops the voice; resume says the sentence again; it ends once', async () => {
    const f = fakeSynth();
    let t = 0;
    const speak = deviceVoice(f.synth, f.make, () => t);
    const clip = speak('Battery lasts two days.', voice, 1);
    const done = vi.fn();
    void clip.done.then(done);
    expect(f.spoken.map((u) => u.text)).toEqual(['Battery lasts two days.']);

    clip.pause();
    expect(f.current).toBeNull(); // really silent (speechSynthesis.pause() would not be)
    await vi.runAllTimersAsync();
    expect(done).not.toHaveBeenCalled(); // a pause is not the end of the sentence

    t += 1000;
    clip.resume();
    expect(f.spoken).toHaveLength(2);
    expect(f.current?.text).toBe('Battery lasts two days.');
    f.end();
    await vi.runAllTimersAsync();
    expect(done).toHaveBeenCalledOnce();
  });

  it('a sentence right after a cancel waits a moment (Chrome drops it otherwise)', () => {
    const f = fakeSynth();
    let t = 0;
    const speak = deviceVoice(f.synth, f.make, () => t);
    speak('One.', voice, 1).stop();
    speak('Two.', voice, 1);
    expect(f.spoken.map((u) => u.text)).toEqual(['One.']);
    t += AFTER_CANCEL_MS;
    vi.advanceTimersByTime(AFTER_CANCEL_MS);
    expect(f.spoken.map((u) => u.text)).toEqual(['One.', 'Two.']);
  });

  it('stop ends the clip; a cancel by someone else also moves on (never hangs)', async () => {
    const f = fakeSynth();
    const speak = deviceVoice(f.synth, f.make, () => 0);
    const a = speak('A.', voice, 1);
    a.stop();
    await expect(a.done).resolves.toBeUndefined();
    vi.advanceTimersByTime(AFTER_CANCEL_MS);
    const b = speak('B.', voice, 1);
    vi.advanceTimersByTime(AFTER_CANCEL_MS);
    f.current?.onerror?.({ error: 'interrupted' }); // e.g. another tab cancelled speech
    await expect(b.done).resolves.toBeUndefined();
  });

  it('a real error is reported to the player', async () => {
    const f = fakeSynth();
    const clip = deviceVoice(f.synth, f.make, () => 1e6)('C.', voice, 1);
    f.current?.onerror?.({ error: 'synthesis-failed' });
    await expect(clip.done).rejects.toThrow('synthesis-failed');
  });
});

describe('speak, interrupting and the settings page in the app', () => {
  let app: App;
  let host: HTMLElement;

  beforeEach(async () => {
    fakeBrowser.reset();
    host = document.createElement('div');
    host.attachShadow({ mode: 'open' });
    document.body.append(host);
    const container = document.createElement('div');
    host.shadowRoot!.append(container);
    app = mountApp(container, await createProfileStore(), createBus(), createMockBackend(), {
      speaker: recordingSpeaker().speaker,
      demo: true,
    });
    app.overlay.open();
  });
  afterEach(() => {
    app.unmount();
    host.remove();
  });

  const root = () => host.shadowRoot!;

  it('Speak without speech recognition (demo) says so and moves to the typing box', async () => {
    root().querySelector<HTMLButtonElement>('.asl-mic')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(root().activeElement).toBe(root().querySelector('.asl-type input'));
  });

  it('interrupting by speaking: on by default on desktop, off on phones, user can change it', () => {
    const coarse = (matches: boolean) =>
      vi.spyOn(window, 'matchMedia').mockReturnValue({ matches } as MediaQueryList);
    coarse(false);
    expect(interruptBySpeaking({ assistantVoice: 'auto' })).toBe(true);
    coarse(true);
    expect(interruptBySpeaking({ assistantVoice: 'auto' })).toBe(false);
    expect(interruptBySpeaking({ assistantVoice: 'auto', interruptBySpeaking: true })).toBe(true);
    vi.restoreAllMocks();
  });

  it('Settings opens as its own page with sections, and Back returns to the menu', () => {
    root().querySelector<HTMLButtonElement>('.asl-settings-toggle')!.click();
    const page = root().querySelector('.asl-content .asl-settings')!;
    expect(root().activeElement?.textContent).toBe('Settings');
    expect([...page.querySelectorAll('legend')].map((l) => l.textContent)).toEqual([
      'Modes',
      'Voice',
      'Text and language',
      'Pointer and switch',
    ]);
    expect(page.textContent).toContain('Stop the assistant by speaking');
    // The menu shrinks to Ask while a page is open.
    expect(root().querySelector('.asl-controls')!.classList.contains('asl-answering')).toBe(true);
    [...page.querySelectorAll('button')].find((b) => b.textContent === 'Back to menu')!.click();
    expect(root().querySelector('.asl-content .asl-settings')).toBeNull();
    expect(root().querySelector('.asl-controls')!.classList.contains('asl-answering')).toBe(false);
  });
});
