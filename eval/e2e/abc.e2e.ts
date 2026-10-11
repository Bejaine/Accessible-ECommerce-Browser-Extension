// Tracks A + B + C end to end, without Track D's UI: MockMart pages (B's store.js), B's extractor
// and actuator, the core turn pipeline with session continuity, and Track C's real backend
// (MOCK=1, started by backend.setup.ts) with Track A's language routes replaying recorded models.
//
// The test plays the browser: each page load gets a fresh pipeline (a new content script) that
// asks a simulated background for the session id and the "continue the task" marker; a click or
// navigate that leaves the page ends the old pipeline, as a real navigation ends its script.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AccessibleOutput,
  Confirmation,
  PageContext,
  Profile,
  TurnRequest,
} from '../../shared/generated/ts';
import profileFixture from '../../fixtures/mocks/Profile.json';
import { performAction } from '../../extension/src/actuate';
import type { BackendClient } from '../../extension/src/core/backend';
import {
  createContinuity,
  createTaskContinuity,
  memoryStore,
  requestSession,
  type ContinuityMessage,
} from '../../extension/src/core/continuity';
import { createSession } from '../../extension/src/core/session';
import { createTurnPipeline, type TurnPipeline } from '../../extension/src/core/turn';
import {
  extractPageContext,
  resolveOrderId,
  restorePlaceholders,
} from '../../extension/src/extract';
import { nodeBackend } from './harness';

const STORE = resolve(__dirname, '../../mock-store');
const STORE_JS = readFileSync(join(STORE, 'store.js'), 'utf8');
const ORIGIN = 'http://localhost:8080';
const TAB = 7;

type HappyWindow = Window & { happyDOM: { setURL(url: string): void }; MOCK_TODAY?: number };

/** One loaded page: its content script's pipeline and everything it showed or said. */
interface Page {
  path: string;
  turn: TurnPipeline;
  sessionId: string;
  continued: boolean;
  shown: AccessibleOutput[];
  said: string[];
  confirmations: (Confirmation | null)[];
  alive: boolean;
}

let backend: BackendClient & { calls: { path: string; ms: number }[] };
let background: ReturnType<typeof createContinuity>;
let requests: TurnRequest[];
let current: Page | null;
/** Where the page asked to go (link, location.href or a navigate action). */
let leaving: string | null;
let profile: Profile;

const sendToBackground = (message: ContinuityMessage) => background.handle(message, TAB);

/** Loads a MockMart page like the browser would; navigations are recorded, not followed. */
function render(path: string): void {
  const win = window as unknown as HappyWindow;
  win.happyDOM.setURL(`${ORIGIN}/${path}`);
  win.MOCK_TODAY = Date.parse('2026-10-10T12:00:00Z');
  const html = readFileSync(join(STORE, path.split('?')[0] ?? ''), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<link[^>]*>/g, '');
  const body = html.match(/<body([^>]*)>([\s\S]*)<\/body>/);
  document.head.innerHTML = html.match(/<head>([\s\S]*)<\/head>/)?.[1] ?? '';
  document.body.innerHTML = body?.[2] ?? '';
  document.body.setAttribute('data-page', body?.[1]?.match(/data-page="(\w+)"/)?.[1] ?? '');
  // store.js sets location.href to move on; record it instead of navigating the test window.
  const location = new Proxy(window.location, {
    get: (target, prop) => {
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set: (target, prop, value) => {
      if (prop === 'href') leaving = new URL(String(value), target.href).href;
      return true;
    },
  });
  new Function('location', STORE_JS)(location);
}

// Links leave the page too.
document.addEventListener(
  'click',
  (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href]');
    if (!a) return;
    e.preventDefault();
    leaving = new URL(a.getAttribute('href') ?? '', window.location.href).href;
  },
  true,
);

/** A page load: a new content script asks the background for the session and the marker. */
async function load(path: string): Promise<Page> {
  if (current) current.alive = false;
  leaving = null;
  render(path);
  const { session_id, continue_task } = await requestSession(sendToBackground);
  const page: Page = {
    path,
    sessionId: session_id,
    continued: continue_task,
    shown: [],
    said: [],
    confirmations: [],
    alive: true,
    turn: null as unknown as TurnPipeline,
  };
  page.turn = createTurnPipeline({
    backend: {
      ...backend,
      turn: async (req) => {
        requests.push(structuredClone(req));
        return backend.turn(req);
      },
    },
    session: createSession(session_id),
    getProfile: () => profile,
    getPage: () => extractPageContext(document),
    perform: async (action, { confirmed }) => {
      leaving = null;
      const result = await performAction(action, {
        confirmed,
        timeoutMs: 300,
        navigate: (url) => void (leaving = url),
      });
      // The page is unloading: this content script never runs another line.
      if (leaving) {
        page.alive = false;
        return new Promise(() => undefined);
      }
      return result;
    },
    showOutput: (o) => void (page.alive && page.shown.push(o)),
    showConfirmation: (c) => void (page.alive && page.confirmations.push(c)),
    announce: (text) => void (page.alive && page.said.push(text)),
    confirmEveryAction: () => false,
    continuity: createTaskContinuity(sendToBackground),
    restore: (text) => restorePlaceholders(text, document),
  });
  current = page;
  if (continue_task) void page.turn.continueTask();
  return page;
}

/** Follows the navigation the last action started, like the browser loading the next page. */
async function follow(): Promise<Page> {
  expect(leaving, 'the page should be navigating').not.toBeNull();
  const url = new URL(leaving!);
  return load(`${url.pathname.slice(1)}${url.search}`);
}

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const last = (p: Page) => p.shown.at(-1)?.summary ?? '';
const store = (): { cart: { id: string }[]; orders: { id: string; status: string }[] } =>
  JSON.parse(localStorage.getItem('asl-mock-store-v1') ?? '{"cart":[],"orders":[]}');
const ctx = (): PageContext => extractPageContext(document);

beforeEach(() => {
  backend = nodeBackend(process.env.ASL_E2E_BACKEND!);
  // A fresh browser: new background (session), fresh shop state.
  background = createContinuity(memoryStore());
  localStorage.clear();
  sessionStorage.clear();
  requests = [];
  current = null;
  profile = structuredClone(profileFixture) as Profile;
  profile.prefs.lang = 'en';
});

describe('A + B + C without the overlay (MockMart, real backend with MOCK=1)', () => {
  it('product questions and add to cart (B extracts and acts, C answers and confirms)', async () => {
    const page = await load('product.html?id=zx-pulse-5g');
    await page.turn.send({ kind: 'phrase', text: 'Price', phrase_id: 'price' });
    expect(last(page)).toContain('₹15,999');
    expect(requests[0]?.page.products[0]?.id).toBe('localhost:zx-pulse-5g');

    await page.turn.send({ kind: 'phrase', text: 'Add to cart', phrase_id: 'add to cart' });
    expect(page.turn.pending?.risk).toBeDefined();
    expect(store().cart).toHaveLength(0); // nothing before yes
    await page.turn.confirm();
    expect(store().cart).toHaveLength(1);
    expect(page.said).toContain('Done.');
  });

  it('place order: summary → high-risk yes → next page continues and verifies', async () => {
    const product = await load('product.html?id=zx-pulse-5g');
    const firstSession = product.sessionId;
    (document.getElementById('add-to-cart') as HTMLButtonElement).click();
    const page = await load('checkout.html');
    expect(page.sessionId).toBe(firstSession);
    await page.turn.send({ kind: 'phrase', text: 'Place my order', phrase_id: 'place my order' });
    const c = page.turn.pending!;
    expect(c.risk).toBe('high');
    expect(c.read_back).toMatchObject({
      total: { amount: 15999, currency: 'INR' },
      pin_code: '500032',
    });
    expect(c.pending_actions.map((a) => a.target_id)).toEqual(['t-place-order']);
    expect(store().orders).toHaveLength(2); // still nothing placed

    void page.turn.confirm(); // the click navigates: this script ends mid-way
    await waitFor(() => leaving !== null, 'the order page to open');
    expect(store().orders[0]).toMatchObject({ id: 'MS-1003', status: 'placed' });

    const next = await follow();
    expect(next.sessionId).toBe(firstSession); // same shopping session on the new page
    expect(next.continued).toBe(true);
    await waitFor(() => next.shown.length > 0, 'the verification answer');
    const verify = requests.at(-1)!;
    expect(verify.input).toMatchObject({ kind: 'phrase', phrase_id: 'continue' });
    expect(verify.page.page_type).toBe('order_detail');
    expect(last(next)).toMatch(/placed/i);
  });

  it('cancel: choose → high-risk yes → cancel page continues → finish → verified', async () => {
    let page = await load('orders.html');
    // Real order numbers never leave the device…
    expect(JSON.stringify(ctx())).not.toMatch(/MS-100\d/);
    await page.turn.send({ kind: 'phrase', text: 'Cancel an order', phrase_id: 'cancel an order' });
    expect(page.turn.pending?.risk).toBe('high');
    // The button tied to the shipped order (the only cancellable one), by its ORDER_n.
    const [cancel] = page.turn.pending!.pending_actions;
    const n = cancel?.target_id?.match(/^t-cancel-(\d+)$/)?.[1];
    expect(resolveOrderId(`ORDER_${n}`, document)).toBe('MS-1002');
    void page.turn.confirm();
    await waitFor(() => leaving !== null, 'the cancel page');

    page = await follow(); // order.html?id=MS-1002&do=cancel
    await waitFor(() => page.turn.pending !== null, 'the finishing confirmation');
    expect(page.turn.pending?.risk).toBe('high');
    void page.turn.confirm();
    await waitFor(() => leaving !== null, 'the cancellation to go through');
    expect(store().orders.find((o) => o.id === 'MS-1002')?.status).toBe('cancelled');

    page = await follow(); // order.html?id=MS-1002&done=cancelled
    await waitFor(() => page.shown.length > 0, 'the verification');
    expect(last(page)).toBe('Done: the page now shows this order as cancelled.');
    // …but what the user hears names the order and item (placeholders restored on device).
    expect(requests.some((r) => JSON.stringify(r).includes('MS-1002'))).toBe(false);
  });

  it('return: reason chip → yes → return page chooses that reason → verified', async () => {
    let page = await load('orders.html');
    await page.turn.send({ kind: 'phrase', text: 'Return an order', phrase_id: 'return an order' });
    expect(last(page)).toMatch(/^Why are you returning/);
    // The reason chip the backend offered (a phrase turn: no LLM needed).
    expect(page.shown.at(-1)?.followups).toContain('It arrived damaged');
    await page.turn.send({ kind: 'phrase', text: 'It arrived damaged' });
    expect(page.turn.pending?.risk).toBe('high');
    void page.turn.confirm();
    await waitFor(() => leaving !== null, 'the return page');

    page = await follow(); // order.html?id=MS-1001&do=return
    await waitFor(() => page.turn.pending !== null, 'the finishing confirmation');
    expect(page.turn.pending?.pending_actions.map((a) => a.type)).toEqual(['select', 'click']);
    void page.turn.confirm();
    await waitFor(() => leaving !== null, 'the return to go through');
    expect(store().orders.find((o) => o.id === 'MS-1001')?.status).toBe('return_requested');

    page = await follow();
    await waitFor(() => page.shown.length > 0, 'the verification');
    expect(last(page)).toBe('Done: the page now shows this order as returned.');
  });

  it('track: the answer names the real order on the device only', async () => {
    const page = await load('orders.html');
    await page.turn.send({ kind: 'phrase', text: 'Track my order', phrase_id: 'track my order' });
    const said = JSON.stringify(page.shown);
    expect(said).toMatch(/shipped|on its way|Which order/i);
    expect(JSON.stringify(requests.at(-1)?.page)).not.toMatch(/MS-100\d/);
  });

  it('secure zone: nothing is sent while the user types card details', async () => {
    await load('product.html?id=nx-charger-33w');
    (document.getElementById('add-to-cart') as HTMLButtonElement).click();
    const page = await load('checkout.html');
    (document.querySelector('input[value="card"]') as HTMLInputElement).click();
    (document.getElementById('cc-number') as HTMLInputElement).focus();
    await page.turn.send({ kind: 'text', text: 'place my order' });
    expect(requests).toHaveLength(0);
    expect(page.shown).toHaveLength(0);
  });

  it('voice (Track A): recorded Hindi audio → /speech/asr → /turn → /speech/tts', async () => {
    profile.prefs.lang = 'hi';
    const page = await load('product.html?id=zx-pulse-5g');
    const wav = readFileSync(resolve(__dirname, '../../fixtures/audio/hi_cart.wav'));
    const asr = await backend.asr({
      schema_version: '1.0',
      audio_base64: wav.toString('base64'),
      encoding: 'wav',
      lang: 'hi',
      mic_level: 0.55,
    });
    expect(asr.text).toBeTruthy();
    expect(asr.asr_meta.mic_level).toBe(0.55);
    await page.turn.send({ kind: 'voice', text: asr.text, asr_meta: asr.asr_meta });
    expect(requests.at(-1)?.input).toMatchObject({ kind: 'voice', lang: 'hi' });
    expect(requests.at(-1)?.input.asr_meta?.mic_level).toBe(0.55);
    const answer = page.shown.at(-1)!;
    const tts = await backend.tts({
      schema_version: '1.0',
      text: answer.summary,
      lang: answer.lang,
    });
    expect(tts.audio_base64.length).toBeGreaterThan(100);
  });

  it('a backend that is down gives a calm message and a retry, never a stack trace', async () => {
    const page = await load('product.html?id=zx-pulse-5g');
    const real = backend.turn;
    backend.turn = () => Promise.reject(new Error('ECONNREFUSED'));
    await page.turn.send({ kind: 'phrase', text: 'Price', phrase_id: 'price' });
    expect(last(page)).toBe(
      "Sorry, I couldn't get an answer just now. Please try again in a moment.",
    );
    expect(page.turn.canRetry).toBe(true);
    backend.turn = real;
    await page.turn.retry();
    expect(last(page)).toContain('₹15,999');
  });
});
