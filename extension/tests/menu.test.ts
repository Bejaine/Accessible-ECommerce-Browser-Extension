// The menu layout and what the turn pipeline now offers the UI: "Did you mean X or Y?",
// "Try again", the order task's step, keeping checkout during card entry, continuing a task.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { IntentAlternative, PageContext, TurnRequest, TurnResponse } from '@shared/index';
import checkoutPage from '../../fixtures/mocks/PageContext.checkout.json';
import turnRequest from '../../fixtures/mocks/TurnRequest.json';
import turnResponse from '../../fixtures/mocks/TurnResponse.json';
import { mountApp, type App } from '../src/core/app';
import { createMockBackend, type BackendClient } from '../src/core/backend';
import { createBus } from '../src/core/bus';
import { createProfileStore, type ProfileStore } from '../src/core/profile';
import { RESUME_KEY } from '../src/core/resume';
import { recordingSpeaker } from './helpers/fakeSpeaker';

// The page the app sees, controlled per test (Track B's extractor is tested on its own).
let currentPage: PageContext;
vi.mock('../src/extract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/extract')>()),
  extractPageContext: vi.fn(() => currentPage),
}));
vi.mock('../src/actuate', () => ({ performAction: vi.fn(async () => ({ ok: true })) }));

const productPage = turnRequest.page as unknown as PageContext;
const baseResponse = turnResponse as unknown as TurnResponse;

function reply(over: Partial<TurnResponse> = {}): TurnResponse {
  return {
    ...baseResponse,
    actions: [],
    confirmation: null,
    workflow: null,
    ...over,
    output: {
      ...baseResponse.output,
      lang: 'en',
      summary: 'Answer.',
      sections: [],
      followups: [],
      warnings: [],
      ...over.output,
    },
  };
}

describe('menu and turn status', () => {
  let host: HTMLElement;
  let app: App;
  let store: ProfileStore;
  let requests: TurnRequest[];
  let next: () => TurnResponse | Promise<TurnResponse>;

  const shadow = () => host.shadowRoot!;
  const live = () => shadow().getElementById('asl-live')!.textContent ?? '';
  const button = (name: string | RegExp) =>
    [...shadow().querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      typeof name === 'string' ? b.textContent?.trim() === name : name.test(b.textContent ?? ''),
    );
  const settle = async () => {
    await vi.waitFor(() => expect(app.turn.busy).toBe(false));
    await vi.advanceTimersByTimeAsync(400);
  };

  function mount(options: Parameters<typeof mountApp>[4] = {}) {
    const container = document.createElement('div');
    shadow().replaceChildren(container);
    const backend: BackendClient = {
      ...createMockBackend(),
      turn: async (req) => {
        requests.push(req);
        return next();
      },
    };
    app = mountApp(container, store, createBus(), backend, {
      speaker: recordingSpeaker().speaker,
      ...options,
    });
    app.overlay.open();
  }

  beforeEach(async () => {
    fakeBrowser.reset();
    vi.useFakeTimers();
    currentPage = structuredClone(productPage);
    requests = [];
    next = () => reply();
    host = document.createElement('div');
    host.attachShadow({ mode: 'open' });
    document.body.append(host);
    store = await createProfileStore();
    mount();
  });

  afterEach(() => {
    app.unmount();
    host.remove();
    vi.useRealTimers();
  });

  it('groups the menu into labelled sections in a fixed order', () => {
    const headings = [...shadow().querySelectorAll('.asl-controls .asl-group > h3')].map(
      (h) => h.textContent,
    );
    expect(headings).toEqual(['Ask', 'Quick questions', 'On this page', 'Reading']);
    const ask = shadow().querySelector('.asl-ask')!;
    expect(ask.querySelector('.asl-mic')).not.toBeNull();
    expect(ask.querySelector('input')?.labels?.[0]?.textContent).toBe('Type a request');
    expect(shadow().querySelector('.asl-phrases')?.closest('.asl-group')?.textContent).toContain(
      'Quick questions',
    );
    // Settings last, the status area (confirmations etc.) first.
    const groups = [...shadow().querySelectorAll('.asl-controls > *')];
    expect(groups[0]!.className).toBe('asl-status');
    expect(groups.at(-1)!.querySelector('.asl-settings-toggle')).not.toBeNull();
  });

  it('typing a request sends it like speech; the box predicts from phrases and the page', async () => {
    const input = shadow().querySelector<HTMLInputElement>('.asl-type input')!;
    const options = [...shadow().querySelectorAll('datalist option')].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(options).toContain("What's the price?");
    expect(options).toContain('Add to Cart');
    input.value = 'is it waterproof';
    shadow().querySelector<HTMLFormElement>('.asl-type')!.requestSubmit();
    await settle();
    expect(requests.at(-1)?.input).toMatchObject({ kind: 'text', text: 'is it waterproof' });
    expect(input.value).toBe('');
  });

  it('"Did you mean X or Y?" shows two big buttons once; tapping one picks it', async () => {
    const alternatives: [IntentAlternative, IntentAlternative] = [
      { label: 'Add to cart', intent: 'add_to_cart', actions: [] },
      { label: 'Read the reviews', intent: 'reviews', actions: [] },
    ];
    next = () =>
      reply({
        intent: { name: 'unclear', confidence: 0.6, alternatives },
        output: { followups: ['Add to cart', 'Read the reviews', 'Help'] } as never,
      });
    await app.say('ad tu kar', 'text');
    await settle();
    const card = shadow().querySelector<HTMLElement>('.asl-card')!;
    expect(card.hidden).toBe(false);
    expect([...card.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Add to cart',
      'Read the reviews',
    ]);
    // Not repeated as follow-up chips under the answer; other follow-ups stay.
    const chips = [...shadow().querySelectorAll('.asl-output button')].map((b) => b.textContent);
    expect(chips).not.toContain('Read the reviews');
    expect(chips).toContain('Help');
    expect(live()).toContain('Did you mean Add to cart, or Read the reviews?');

    next = () => reply({ output: { summary: 'Here are the reviews.' } as never });
    card.querySelector<HTMLButtonElement>('button:nth-child(2)')!.click();
    await settle();
    expect(requests.at(-1)?.input).toMatchObject({ kind: 'phrase', text: 'Read the reviews' });
    expect(card.hidden).toBe(true);
  });

  it('saying "second one" (or the label) picks an option on the device', async () => {
    next = () =>
      reply({
        intent: {
          name: 'unclear',
          confidence: 0.6,
          alternatives: [
            { label: 'Track my order', intent: 'track', actions: [] },
            { label: 'Cancel my order', intent: 'cancel', actions: [] },
          ],
        },
      });
    await app.say('trak oder', 'text');
    await settle();
    const before = requests.length;
    next = () => reply();
    await app.say('second one', 'voice');
    await settle();
    expect(requests).toHaveLength(before + 1);
    expect(requests.at(-1)?.input).toMatchObject({ kind: 'phrase', text: 'Cancel my order' });
  });

  it('the options are scanned first when switch scanning starts', async () => {
    next = () =>
      reply({
        intent: {
          name: 'unclear',
          confidence: 0.6,
          alternatives: [
            { label: 'Add to cart', intent: 'a', actions: [] },
            { label: 'Buy now', intent: 'b', actions: [] },
          ],
        },
      });
    await app.say('ad', 'text');
    await settle();
    app.controls.startScanning(currentPage.targets);
    expect(shadow().querySelector('.asl-scan-item')?.textContent).toBe('Did you mean…');
    app.controls.stopScanning();
  });

  it('a failed turn offers "Try again", by button or by saying it', async () => {
    next = () => Promise.reject(new TypeError('Failed to fetch'));
    await app.say('price please', 'text');
    await settle();
    const retry = button('Try again')!;
    expect(retry.hidden).toBe(false);
    expect(live()).toContain("couldn't get an answer");
    next = () => reply({ output: { summary: 'It costs ₹17,999.' } as never });
    await app.say('try again', 'voice');
    await settle();
    expect(requests.at(-1)?.input.text).toBe('price please');
    expect(retry.hidden).toBe(true);
  });

  it('an order task shows and announces its step', async () => {
    next = () => reply({ workflow: { name: 'cancel_order', step: 2, total_steps: 3 } as never });
    await app.say('cancel my order', 'text');
    await settle();
    const progress = shadow().querySelector<HTMLElement>('.asl-progress')!;
    expect(progress.hidden).toBe(false);
    expect(progress.textContent).toBe('Cancelling your order: step 2 of 3');
    expect(live()).toContain('Cancelling your order: step 2 of 3');
    next = () => reply();
    await app.say('stop', 'text');
    await app.turn.send({ kind: 'text', text: 'done' });
    await settle();
    expect(progress.hidden).toBe(true);
  });

  it('checkout steps stay while the user types in a card field (nothing is re-read then)', () => {
    currentPage = structuredClone(checkoutPage) as unknown as PageContext;
    app.overlay.close();
    app.overlay.open(); // refreshes page tools
    expect(button('Checkout step by step')!.hidden).toBe(false);
    currentPage = { ...currentPage, checkout: null, secure_zone_active: true };
    app.overlay.close();
    app.overlay.open();
    expect(button('Checkout step by step')!.hidden).toBe(false);
    // Leaving the field reads the page again as usual.
    currentPage = { ...currentPage, checkout: null, secure_zone_active: false };
    app.overlay.close();
    app.overlay.open();
    expect(button('Checkout step by step')!.hidden).toBe(true);
  });

  it('continuing an order task says so, and skips the "resume reading" offer', async () => {
    app.unmount();
    await browser.storage.local.set({
      [RESUME_KEY]: {
        snap: {
          sections: [{ segments: [{ text: 'Old answer' }] }],
          lang: 'en',
          section: 0,
          index: 0,
        },
        site: location.hostname,
        saved_at: Date.now(),
      },
    });
    const rec = recordingSpeaker();
    mount({ speaker: rec.speaker, continueTask: true });
    next = () => reply({ output: { summary: 'Your order is placed.' } as never });
    await app.continueTask();
    await settle();
    expect(requests.at(-1)?.input).toMatchObject({ kind: 'phrase', phrase_id: 'continue' });
    expect(live()).toContain('Continuing your order');
    expect(rec.calls).not.toContain('offerResume');
  });
});
