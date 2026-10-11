// @vitest-environment-options {"settings":{"navigation":{"disableMainFrameNavigation":true},"disableCSSFileLoading":true,"disableJavaScriptFileLoading":true}}
// Persona runs (docs/conditions.md "Required combinations"; M1 testing plan "Personas & latency").
// Real MockMart pages (Track B's store.js), Track B's extractor + actuator, Track D's app driven only
// through each persona's input method, and Track C's real backend (MOCK=1: taps and phrase chips
// need no LLM). The assistant's voice is a recording stand-in (no audio device in tests).
// Writes eval/e2e/report.md from what actually happened.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { Mic } from '../../extension/src/audio/mic';
import { mountApp, type App } from '../../extension/src/core/app';
import { createBus } from '../../extension/src/core/bus';
import { resolveMode, setConditionActive } from '../../extension/src/core/composer';
import { createProfileStore, type ProfileStore } from '../../extension/src/core/profile';
import { recordingSpeaker } from '../../extension/tests/helpers/fakeSpeaker';
import { cart, key, nodeBackend, openMockMart, realSleep, resetMockMart, until } from './harness';

type Condition = 'visual' | 'speech' | 'motor' | 'ageing';

interface Run {
  persona: string;
  input: string;
  result: 'completed' | 'blocked' | 'failed';
  detail: string;
  steps: number;
  turnMs: number[];
}

const runs: Run[] = [];
let backend: ReturnType<typeof nodeBackend>;
let app: App | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  backend = nodeBackend(process.env.ASL_E2E_BACKEND!);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

afterAll(() => {
  const median = (xs: number[]) =>
    xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null;
  const lines = [
    '# Persona runs (end to end on MockMart)',
    '',
    `Generated ${new Date().toISOString()} by \`make e2e\`. MockMart pages + Track B's extractor and actuator +`,
    "Track D's app + Track C's backend (MOCK=1, local). Voice output recorded, not played.",
    'Latency = one /turn round trip to the local backend (no LLM on these paths; real LLM/ASR/TTS add more).',
    '',
    '| Persona | Input | Result | Steps | /turn calls | Median /turn (ms) | Detail |',
    '|---|---|---|---|---|---|---|',
    ...runs.map(
      (r) =>
        `| ${r.persona} | ${r.input} | ${r.result} | ${r.steps} | ${r.turnMs.length} | ${median(r.turnMs) ?? '-'} | ${r.detail} |`,
    ),
  ];
  writeFileSync(join(__dirname, 'report.md'), lines.join('\n') + '\n');
  console.info(lines.join('\n'));
});

async function mountOn(path: string, conditions: Condition[], opts: { keepStore?: boolean } = {}) {
  fakeBrowser.reset();
  if (!opts.keepStore) resetMockMart();
  const page = openMockMart(path);
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  const store: ProfileStore = await createProfileStore();
  for (const c of conditions) await store.update((d) => setConditionActive(d, c, true, 'user', 1));
  host = document.createElement('div');
  const container = document.createElement('div');
  host.attachShadow({ mode: 'open' }).appendChild(container);
  document.body.appendChild(host);
  const rec = recordingSpeaker();
  const mic = {
    listening: false,
    muted: false,
    listen: () => new Promise(() => undefined),
    stop: () => undefined,
    mute: vi.fn(),
    unmute: vi.fn(),
  } as unknown as Mic;
  backend.calls.length = 0;
  app = mountApp(container, store, createBus(), backend, { speaker: rec.speaker, mic, demo: true });
  const shadow = host.shadowRoot!;
  return { page, store, rec, mic, shadow, mode: resolveMode(store.get()) };
}

const turnTimes = () => backend.calls.filter((c) => c.path === '/turn').map((c) => c.ms);
const live = (shadow: ShadowRoot) => shadow.getElementById('asl-live')?.textContent ?? '';
const buttonNamed = (shadow: ShadowRoot, re: RegExp) =>
  [...shadow.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => re.test(b.textContent ?? '') && !b.closest('[hidden]'),
  );

/** Put one phone in MockMart's cart through MockMart's own page. */
function seedCart(): number {
  resetMockMart();
  openMockMart('product.html?id=zx-pulse-5g');
  document.getElementById('add-to-cart')!.click();
  return cart().length;
}

/** Single switch: let the highlight move until it reaches `re`, then press Space. */
async function scanPick(shadow: ShadowRoot, re: RegExp, interval: number): Promise<number> {
  const highlighted = () => shadow.querySelector('.asl-scan-item')?.textContent ?? '';
  let waits = 0;
  while (!re.test(highlighted())) {
    if (++waits > 80) throw new Error(`scanning never reached ${re} (at "${highlighted()}")`);
    vi.advanceTimersByTime(interval);
  }
  // A person's reaction time after the highlight arrives (scanning slows down for presses that
  // land right on a move); real time, since only timers are faked and the scan doesn't move.
  await realSleep(600);
  key('Space');
  await realSleep(350); // the switch ignores presses closer than 300 ms (tremor debounce)
  return 1;
}

async function record(
  persona: string,
  input: string,
  fn: () => Promise<{ steps: number; detail: string; blocked?: boolean }>,
) {
  try {
    const { steps, detail, blocked } = await fn();
    runs.push({
      persona,
      input,
      result: blocked ? 'blocked' : 'completed',
      detail,
      steps,
      turnMs: turnTimes(),
    });
  } catch (error) {
    runs.push({
      persona,
      input,
      result: 'failed',
      detail: String((error as Error).message ?? error),
      steps: 0,
      turnMs: turnTimes(),
    });
    throw error;
  }
}

describe('personas on MockMart', () => {
  it(
    'visual + motor: auditory switch scanning adds a phone to the cart',
    { timeout: 60_000 },
    async () => {
      await record(
        'Blind, hand tremor (visual + motor)',
        'Single switch (Space), every highlight spoken',
        async () => {
          const { shadow, rec, mode } = await mountOn('product.html?id=zx-pulse-5g', [
            'visual',
            'motor',
          ]);
          app!.toggleAssistant(); // Alt+Shift+A
          let steps = 1;
          buttonNamed(shadow, /^Settings$/)!.click();
          buttonNamed(shadow, /^Start switch scanning$/)!.click();
          steps += 2;
          steps += await scanPick(shadow, /^Product$/, mode.scan_interval_ms);
          steps += await scanPick(shadow, /^Add to Cart$/i, mode.scan_interval_ms);
          await until(() => app!.turn.pending !== null, 10_000, 'confirmation');
          key('Space'); // one switch press = yes
          steps += 1;
          await until(() => cart().length === 1, 10_000, 'cart updated');
          vi.advanceTimersByTime(200);
          const spoke = rec.calls.filter((c) => c.startsWith('prompt:')).length;
          expect(spoke).toBeGreaterThan(2); // highlights were read out (auditory scanning)
          return {
            steps,
            detail: `cart 1 item; ${spoke} highlights spoken; scan ${mode.scan_interval_ms} ms`,
          };
        },
      );
    },
  );

  it('visual + speech: typed command with a typo, then "yes"', { timeout: 60_000 }, async () => {
    await record(
      'Blind, unclear speech (visual + speech)',
      'Keyboard: "add to card", then "yes"',
      async () => {
        await mountOn('product.html?id=zx-pulse-5g', ['visual', 'speech']);
        await app!.say('add to card', 'text'); // local matcher -> Add to Cart target -> /turn
        await until(() => app!.turn.pending !== null, 10_000, 'confirmation');
        await app!.say('yes', 'text'); // handled on the device
        await until(() => cart().length === 1, 10_000, 'cart updated');
        return { steps: 2, detail: 'typo matched locally; confirmation by "yes"; cart 1 item' };
      },
    );
  });

  it('speech + motor: phrase chip chosen by switch scanning', { timeout: 60_000 }, async () => {
    await record(
      'Unclear speech, tremor (speech + motor)',
      'Phrase chips by single switch',
      async () => {
        const { shadow, mode } = await mountOn('product.html?id=zx-pulse-5g', ['speech', 'motor']);
        expect(mode.input_rung).toBe('phrase');
        app!.toggleAssistant(); // Alt+Shift+A
        let steps = 1;
        buttonNamed(shadow, /^Settings$/)!.click();
        buttonNamed(shadow, /^Start switch scanning$/)!.click();
        steps += 2;
        steps += await scanPick(shadow, /^Phrases$/, mode.scan_interval_ms);
        steps += await scanPick(shadow, /^Add to cart$/, mode.scan_interval_ms);
        await until(() => app!.turn.pending !== null, 10_000, 'confirmation');
        key('Space');
        steps += 1;
        await until(() => cart().length === 1, 10_000, 'cart updated');
        return { steps, detail: "chip sent as Track C's 'add to cart' (no LLM); cart 1 item" };
      },
    );
  });

  it(
    'ageing + visual + motor (demo persona): shortcut, simplified view, big buttons',
    { timeout: 60_000 },
    async () => {
      await record(
        'Older, blind, hand tremor (ageing + visual + motor)',
        'Opens by itself in simple mode, large buttons',
        async () => {
          const { shadow, store, mode } = await mountOn('product.html?id=zx-pulse-5g', [
            'ageing',
            'visual',
            'motor',
          ]);
          // Simple mode: the panel opened by itself on this product page, in the simple view.
          expect(app!.overlay.isOpen).toBe(true);
          expect(shadow.querySelector('.asl-simple')).not.toBeNull();
          buttonNamed(shadow, /^Add to Cart$/i)!.click();
          await until(() => app!.turn.pending !== null, 10_000, 'confirmation');
          buttonNamed(shadow, /^Yes$/)!.click();
          await until(() => cart().length === 1, 10_000, 'cart updated');
          expect(store.get().prefs.tts_rate).toBe(0.75);
          expect(mode.max_options).toBe(3);
          return {
            steps: 3,
            detail: `opened by itself in the simplified view; text ${store.get().prefs.text_scale}x; speech ${store.get().prefs.tts_rate}x; ${mode.max_options} options/step; cart 1 item`,
          };
        },
      );
    },
  );

  it(
    'checkout in simple mode: blocked until the checkout summary is extracted',
    { timeout: 60_000 },
    async () => {
      await record(
        'Older user at checkout (ageing)',
        'Checkout steps, "place my order"',
        async () => {
          const items = seedCart();
          const { page, shadow } = await mountOn('checkout.html', ['ageing'], { keepStore: true });
          app!.overlay.open();
          const hasSummary = page.checkout != null;
          await app!.turn.send({
            kind: 'phrase',
            phrase_id: 'place my order',
            text: 'place my order',
          });
          vi.advanceTimersByTime(200);
          const said = shadow.querySelector('.asl-summary')?.textContent ?? live(shadow);
          const ordered =
            JSON.parse(localStorage.getItem('asl-mock-store-v1') ?? '{}').orders?.length ?? 0;
          expect(app!.turn.pending?.risk ?? 'none').not.toBe('low'); // never a low-risk order
          return {
            steps: 2,
            blocked: !hasSummary,
            detail: hasSummary
              ? `summary extracted; backend: "${said}"`
              : `no PageContext.checkout from the extractor (cart had ${items} item); backend refused safely: "${said.slice(0, 90)}"; orders unchanged (${ordered})`,
          };
        },
      );
    },
  );

  it('secure zone: the card number field turns the mic off', { timeout: 60_000 }, async () => {
    await record('Any user at payment', 'Focus the card number field', async () => {
      seedCart();
      const { mic, shadow } = await mountOn('checkout.html', [], { keepStore: true });
      const cardRadio = document.querySelector<HTMLInputElement>(
        'input[name="payment"][value="card"]',
      );
      cardRadio?.click();
      cardRadio?.dispatchEvent(new Event('change', { bubbles: true }));
      const card =
        document.querySelector<HTMLInputElement>('input[autocomplete="cc-number"]') ??
        document.querySelector<HTMLInputElement>('input[name*="card" i], input[id*="card" i]');
      if (!card) return { steps: 0, blocked: true, detail: 'no card field on the checkout page' };
      card.focus();
      card.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      vi.advanceTimersByTime(200);
      expect(mic.mute).toHaveBeenCalled();
      return { steps: 1, detail: `mic muted; said "${live(shadow).slice(0, 70)}"` };
    });
  });
});
