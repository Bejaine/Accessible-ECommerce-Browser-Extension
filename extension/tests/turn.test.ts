import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import prepared from '../../fixtures/mocks/ProductPrepareResponse.json';
import { performAction } from '../src/actuate';
import { mountApp, type App } from '../src/core/app';
import { createMockBackend, MOCK_WARNING, type BackendClient } from '../src/core/backend';
import { createBus, type Bus } from '../src/core/bus';
import { setConditionActive } from '../src/core/composer';
import { createProfileStore, type ProfileStore } from '../src/core/profile';

// Same behaviour as Track B's stub (reports failure), but observable.
vi.mock('../src/actuate', () => ({
  performAction: vi.fn(async () => ({ ok: false, reason: 'not implemented' })),
}));

/** Buttons -> turn pipeline -> output, confirmations and local commands, through the real app. */
describe('turns from the overlay buttons', () => {
  let host: HTMLElement;
  let app: App;
  let store: ProfileStore;
  let bus: Bus;
  let backend: BackendClient;

  const shadow = () => host.shadowRoot!;
  const q = <T extends Element = HTMLElement>(sel: string) => shadow().querySelector<T>(sel);
  const buttonNamed = (scope: string, name: string) =>
    [...shadow().querySelectorAll<HTMLButtonElement>(`${scope} button`)].find(
      (b) => b.textContent === name,
    );
  const live = () => shadow().getElementById('asl-live')!.textContent ?? '';
  const settle = async () => {
    await vi.waitFor(() => expect(app.turn.busy).toBe(false));
    await vi.advanceTimersByTimeAsync(100);
  };

  async function mount(b: BackendClient = createMockBackend()) {
    // One app at a time: a second mount without unmounting would leave the first one's key
    // listeners on the document.
    (app as App | undefined)?.unmount();
    const container = document.createElement('div');
    host.shadowRoot!.replaceChildren(container);
    bus = createBus();
    backend = b;
    app = mountApp(container, store, bus, backend);
  }

  beforeEach(async () => {
    fakeBrowser.reset();
    vi.useFakeTimers();
    host = document.createElement('div');
    host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
    store = await createProfileStore();
    await mount();
  });

  afterEach(() => {
    app.unmount();
    host.remove();
    vi.useRealTimers();
  });

  it('a confirmation whose prompt is the answer summary is announced once, not twice', async () => {
    const prompt = 'Add Zentra Pulse 5G to your cart? Quantity 1, price ₹17,999.';
    const base = createMockBackend();
    await mount({
      ...base,
      turn: async (req) => {
        const res = await base.turn(req);
        return {
          ...res,
          output: { ...res.output, lang: 'en', summary: prompt, sections: [], warnings: [] },
          confirmation: { ...res.confirmation!, prompt },
        };
      },
    });
    await app.say('add to cart please', 'text');
    await settle();
    expect(app.turn.pending?.prompt).toBe(prompt);
    expect(live().split(prompt)).toHaveLength(2); // exactly one occurrence
  });

  it('a phrase button sends a turn and shows the answer (labelled as demo data)', async () => {
    const spy = vi.spyOn(backend, 'turn');
    bus.emit({ type: 'phrase', id: 'reviews', text: 'What do reviews say?' });
    await settle();
    const sent = spy.mock.calls[0]![0];
    expect(sent.input).toMatchObject({ kind: 'phrase', phrase_id: 'reviews', lang: 'en' });
    expect(sent.schema_version).toBe('1.0');
    expect(q('.asl-summary')?.textContent).toBe(prepared.sections.reviews!.summary);
    expect(q('.asl-warnings')?.textContent).toContain(MOCK_WARNING);
    expect(live()).toContain(prepared.sections.reviews!.summary);
  });

  it('add to cart asks for confirmation with the read-back; nothing runs before yes', async () => {
    const perform = vi.mocked(performAction);
    perform.mockClear();
    bus.emit({ type: 'phrase', id: 'add_to_cart', text: 'Add to cart' });
    await settle();
    const card = q('.asl-confirm')!;
    expect(card.hidden).toBe(false);
    expect(card.querySelector('dl')?.textContent).toBe('Quantity1Total₹17,999');
    expect(perform).not.toHaveBeenCalled();
    expect(app.overlay.isOpen).toBe(true);
    expect(shadow().activeElement?.textContent).toBe('Yes');

    buttonNamed('.asl-confirm', 'Yes')!.click();
    await vi.advanceTimersByTimeAsync(100);
    expect(perform).toHaveBeenCalledWith(expect.objectContaining({ target_id: 't-add-to-cart' }), {
      confirmed: true,
    });
    // The actuator is Track B's stub: it reports failure, and the user is told honestly.
    expect(live()).toContain("That didn't work on this page");
    expect(card.hidden).toBe(true);
  });

  it('an actuator failure reason becomes a specific, calm message', async () => {
    // Track B's full ActionResult shape; cast so this compiles against the stub's narrower type too.
    vi.mocked(performAction).mockResolvedValueOnce({
      ok: false,
      performed: false,
      verified: null,
      reason: 'secure_zone',
    } as unknown as Awaited<ReturnType<typeof performAction>>);
    bus.emit({ type: 'phrase', id: 'add_to_cart', text: 'Add to cart' });
    await settle();
    buttonNamed('.asl-confirm', 'Yes')!.click();
    await vi.advanceTimersByTimeAsync(100);
    expect(live()).toContain("I can't do that inside a payment or password field.");
  });

  it('Escape cancels a confirmation; one switch press confirms it', async () => {
    bus.emit({ type: 'phrase', id: 'add_to_cart', text: 'Add to cart' });
    await settle();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(app.turn.pending).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(live()).toContain('Cancelled. Nothing was changed.');

    bus.emit({ type: 'phrase', id: 'add_to_cart', text: 'Add to cart' });
    await settle();
    // One switch press = a tap of Space (down, then up before the hold time).
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true }),
    );
    document.body.dispatchEvent(
      new KeyboardEvent('keyup', { code: 'Space', bubbles: true, cancelable: true }),
    );
    expect(app.turn.pending).toBeNull();
  });

  it('saying "yes" / "no" is handled on the device (local fast path, no server call)', async () => {
    bus.emit({ type: 'phrase', id: 'add_to_cart', text: 'Add to cart' });
    await settle();
    const spy = vi.spyOn(backend, 'turn');
    await app.say('no');
    expect(app.turn.pending).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('"slower" / "faster" and the speed buttons change speech speed and save it', async () => {
    await app.say('slower');
    await vi.waitFor(() => expect(store.get().prefs.tts_rate).toBe(0.75));
    buttonNamed('.asl-speed', 'Faster')!.click();
    buttonNamed('.asl-speed', 'Faster')!.click();
    await vi.waitFor(() => expect(store.get().prefs.tts_rate).toBe(1.25));
    expect(q('.asl-speed-value')?.textContent).toBe('Speech speed 1.25×');
    expect(
      ((await fakeBrowser.storage.local.get('profile')).profile as { prefs: { tts_rate: number } })
        .prefs.tts_rate,
    ).toBe(1.25);
  });

  it('ageing starts slower but the user can speed it up afterwards', async () => {
    await store.update((d) => setConditionActive(d, 'ageing', true, 'user'));
    expect(store.get().prefs.tts_rate).toBe(0.75);
    await app.say('faster');
    await vi.waitFor(() => expect(store.get().prefs.tts_rate).toBe(1));
  });

  it('with ageing on, even a safe action is confirmed first', async () => {
    await store.update((d) => setConditionActive(d, 'ageing', true, 'user'));
    const safe = createMockBackend();
    safe.turn = async () => ({
      ...(await createMockBackend().turn({ input: { phrase_id: 'specs' } } as never)),
      actions: [
        {
          schema_version: '1.0',
          id: 'act-scroll',
          type: 'scroll',
          target_id: null,
          value: 'reviews',
          expected_effect: { kind: 'none', detail: null },
        },
      ],
    });
    await mount(safe);
    await app.say('scroll to the reviews', 'text');
    await settle();
    expect(app.turn.pending?.prompt).toBe('Shall I go ahead?');
  });

  it('"help" and "repeat" work without the server', async () => {
    const spy = vi.spyOn(backend, 'turn');
    await app.say('repeat');
    await vi.advanceTimersByTimeAsync(100);
    expect(live()).toContain('There is nothing to repeat yet.');
    bus.emit({ type: 'phrase', id: 'help', text: 'Help' });
    expect(q('.asl-output h3')?.textContent).toBe('Things you can say');
    await app.say('repeat that');
    await vi.advanceTimersByTimeAsync(100);
    expect(live()).toContain('You can press a phrase button');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a backend failure becomes a calm spoken message, never a silent failure', async () => {
    const failing = createMockBackend();
    failing.turn = () =>
      Promise.reject({
        error: 'The assistant is busy. Please try again.',
        code: 'rate_limited',
        retryable: true,
      });
    await mount(failing);
    bus.emit({ type: 'phrase', id: 'price', text: "What's the price?" });
    await settle();
    // A calm message chosen by the error code; the backend's own text is never read out.
    expect(q('.asl-summary')?.textContent).toBe(
      'Lots of requests right now. Please try again in a moment.',
    );
    expect(live()).toContain('Lots of requests right now');
    expect(app.turn.canRetry).toBe(true);
  });
});
