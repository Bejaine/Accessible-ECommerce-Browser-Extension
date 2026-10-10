import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import prepared from '../../fixtures/mocks/ProductPrepareResponse.json';
import type { Mic, Utterance } from '../src/audio/mic';
import { MicError } from '../src/audio/mic';
import { mountApp, type App } from '../src/core/app';
import { createMockBackend, type BackendClient } from '../src/core/backend';
import { createBus, type Bus } from '../src/core/bus';
import { setConditionActive } from '../src/core/composer';
import { createProfileStore, type ProfileStore } from '../src/core/profile';
import { recordingSpeaker } from './helpers/fakeSpeaker';

function fakeMic(next: () => Promise<Utterance>): Mic & { modes: string[] } {
  const modes: string[] = [];
  return {
    modes,
    listening: false,
    muted: false,
    listen: (opts) => {
      modes.push(opts?.mode ?? 'default');
      opts?.onLevel?.(0.6);
      return next();
    },
    stop: () => undefined,
    mute: () => undefined,
    unmute: () => undefined,
  };
}

const speech = (micLevel = 0.5): Utterance => ({
  reason: 'silence',
  wav: new Uint8Array(4),
  audioBase64: 'UklGRg==',
  durationMs: 1200,
  micLevel,
});

describe('voice input (Track A mic) -> ASR -> local fast path or turn', () => {
  let host: HTMLElement;
  let app: App;
  let store: ProfileStore;
  let bus: Bus;
  let backend: BackendClient;
  let mic: ReturnType<typeof fakeMic>;

  const live = () => host.shadowRoot!.getElementById('asl-live')!.textContent ?? '';

  async function mount(next: () => Promise<Utterance>, b = createMockBackend()) {
    const container = document.createElement('div');
    host.shadowRoot!.replaceChildren(container);
    bus = createBus();
    backend = b;
    mic = fakeMic(next);
    app = mountApp(container, store, bus, backend, { mic });
  }

  beforeEach(async () => {
    fakeBrowser.reset();
    vi.useFakeTimers();
    host = document.createElement('div');
    host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
    store = await createProfileStore();
  });

  afterEach(() => {
    app.unmount();
    host.remove();
    vi.useRealTimers();
  });

  it('a recognised utterance becomes a voice turn carrying asr_meta', async () => {
    await mount(async () => speech());
    const turn = vi.spyOn(backend, 'turn');
    await app.listen();
    await vi.waitFor(() => expect(turn).toHaveBeenCalled());
    const input = turn.mock.calls[0]![0].input;
    expect(input.kind).toBe('voice');
    expect(input.text).toBe('isse cart mein daal do');
    expect(input.asr_meta).toMatchObject({ mic_level: 0.46 });
    expect(mic.modes).toEqual(['default']);
  });

  it('the speech condition uses speech mode (longer silence timeout)', async () => {
    await store.update((d) => setConditionActive(d, 'speech', true, 'user'));
    await mount(async () => speech());
    await app.listen();
    expect(mic.modes).toEqual(['speech']);
  });

  it('a spoken command is handled on the device', async () => {
    await mount(async () => speech());
    backend.asr = async () => ({
      schema_version: '1.0',
      text: 'slower',
      lang: 'en',
      asr_meta: { confidence: null, mic_level: 0.5, alternatives: [] },
    });
    const turn = vi.spyOn(backend, 'turn');
    await app.listen();
    await vi.waitFor(() => expect(store.get().prefs.tts_rate).toBe(0.75));
    expect(turn).not.toHaveBeenCalled();
  });

  it('two misses in a row offer the phrase board instead of asking a third time', async () => {
    await mount(async () => speech(0.5));
    backend.asr = async () => ({
      schema_version: '1.0',
      text: '',
      lang: 'en',
      asr_meta: { confidence: null, mic_level: 0.5, alternatives: [] },
    });
    await app.listen();
    await vi.advanceTimersByTimeAsync(100);
    expect(live()).toContain("Sorry, I didn't catch that.");
    await app.listen();
    await vi.advanceTimersByTimeAsync(100);
    expect(live()).toContain('Here are some phrases you can choose instead.');
    expect(app.overlay.isOpen).toBe(true);
    expect(app.engine.log.map((s) => s.kind)).toContain('unheard_speech');
  });

  it('silence (no audio) is a mic problem: no speech evidence, offer typing', async () => {
    await mount(async () => ({
      ...speech(0.01),
      audioBase64: null,
      wav: null,
      reason: 'no_speech',
    }));
    await app.listen();
    await vi.advanceTimersByTimeAsync(100);
    expect(live()).toContain("I didn't hear anything.");
    expect(app.engine.log).toHaveLength(0);
  });

  it('mic errors are spoken with Track A strings', async () => {
    await mount(() => Promise.reject(new MicError('permission_denied', 'denied')));
    await app.listen();
    await vi.advanceTimersByTimeAsync(100);
    expect(live()).toContain("I can't use the microphone because permission was not given.");
    expect(host.shadowRoot!.querySelector('.asl-mic')?.textContent).toBe('Speak');
  });
});

describe('page preparation (Track C /product/prepare)', () => {
  let host: HTMLElement;
  let app: App;

  afterEach(() => {
    app.unmount();
    host.remove();
    document.head.querySelector('script[type="application/ld+json"]')?.remove();
    vi.useRealTimers();
  });

  it('prepares the product at load and answers section phrases from the cache', async () => {
    fakeBrowser.reset();
    vi.useFakeTimers();
    // A minimal product page for Track B's extractor (JSON-LD tier).
    const ld = document.createElement('script');
    ld.type = 'application/ld+json';
    ld.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'Example Phone',
      offers: { '@type': 'Offer', price: '9999', priceCurrency: 'INR' },
    });
    document.head.append(ld);
    host = document.createElement('div');
    const container = document.createElement('div');
    host.attachShadow({ mode: 'open' }).appendChild(container);
    document.body.appendChild(host);
    const backend = createMockBackend();
    const prepare = vi.spyOn(backend, 'prepareProduct');
    const turn = vi.spyOn(backend, 'turn');
    const bus = createBus();
    app = mountApp(container, await createProfileStore(), bus, backend, {
      mic: fakeMic(async () => speech()),
    });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(prepare.mock.calls[0]![0].product.title).toBe('Example Phone');
    await prepare.mock.results[0]!.value; // sections are cached once prepare resolves
    bus.emit({ type: 'phrase', id: 'reviews', text: 'What do reviews say?' });
    expect(host.shadowRoot!.querySelector('.asl-summary')?.textContent).toBe(
      prepared.sections.reviews!.summary,
    );
    expect(turn).not.toHaveBeenCalled();
  });
});

describe('wiring across tracks', () => {
  let host: HTMLElement;
  let app: App;

  afterEach(() => {
    app?.unmount();
    host?.remove();
    document.head.querySelector('script[type="application/ld+json"]')?.remove();
    document.body.querySelectorAll('input').forEach((i) => i.remove());
    vi.useRealTimers();
  });

  async function mountWith(mic: Mic, opts: { demo?: boolean } = {}, backend = createMockBackend()) {
    fakeBrowser.reset();
    host = document.createElement('div');
    const container = document.createElement('div');
    host.attachShadow({ mode: 'open' }).appendChild(container);
    document.body.appendChild(host);
    app = mountApp(container, await createProfileStore(), createBus(), backend, {
      mic,
      speaker: recordingSpeaker().speaker,
      demo: opts.demo ?? false,
    });
    return backend;
  }

  it("secure zone (Track B) mutes Track A's mic in a password field and says so; leaving unmutes", async () => {
    vi.useFakeTimers();
    const mute = vi.fn();
    const unmute = vi.fn();
    const mic = { ...fakeMic(async () => speech()), mute, unmute };
    await mountWith(mic);
    const password = document.createElement('input');
    password.type = 'password';
    document.body.append(password);
    password.focus();
    password.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(mute).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(host.shadowRoot!.getElementById('asl-live')!.textContent).toContain(
      "Listening is paused while you're in a payment or password field.",
    );
    password.blur();
    document.body.focus();
    password.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(10);
    expect(unmute).toHaveBeenCalled();
  });

  function productPage() {
    const ld = document.createElement('script');
    ld.type = 'application/ld+json';
    ld.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'Example Phone',
      offers: { '@type': 'Offer', price: '9999', priceCurrency: 'INR' },
    });
    document.head.append(ld);
  }

  it("extraction fallback (Track B's tier 3) runs on a real backend before /product/prepare", async () => {
    productPage();
    const backend = createMockBackend();
    const fallback = vi.spyOn(backend, 'extractFallback');
    const prepare = vi.spyOn(backend, 'prepareProduct');
    await mountWith(
      fakeMic(async () => speech()),
      { demo: false },
      backend,
    );
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(fallback).toHaveBeenCalledOnce();
    expect(fallback.mock.calls[0]![0]).toMatchObject({
      schema_version: '1.0',
      missing: expect.any(Array),
    });
    expect(prepare.mock.calls[0]![0].product.title).toBe('Example Phone'); // page tiers win
  });

  it('never in demo mode: the mock would describe the fixture phone, not this page (rule 1)', async () => {
    productPage();
    const backend = createMockBackend();
    const fallback = vi.spyOn(backend, 'extractFallback');
    const prepare = vi.spyOn(backend, 'prepareProduct');
    await mountWith(
      fakeMic(async () => speech()),
      { demo: true },
      backend,
    );
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(fallback).not.toHaveBeenCalled();
  });
});
