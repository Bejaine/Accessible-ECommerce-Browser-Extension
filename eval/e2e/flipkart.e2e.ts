// Flipkart product page (saved real page) through Track B's page map and actuator and Track C's
// real backend (MOCK=1): the controls Flipkart builds from <div>s (React Native Web) can be
// found, confirmed and pressed. Before, "Add to cart" was not in the page map at all, so voice,
// chips and the local matcher had nothing to press.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AccessibleOutput, Profile } from '../../shared/generated/ts';
import profileFixture from '../../fixtures/mocks/Profile.json';
import { performAction } from '../../extension/src/actuate';
import { createSession } from '../../extension/src/core/session';
import { createTurnPipeline, type TurnPipeline } from '../../extension/src/core/turn';
import { extractPageContext, resolveTarget } from '../../extension/src/extract';
import { nodeBackend } from './harness';

const PAGES = resolve(__dirname, '../../fixtures/pages');
const PAGE = 'flipkart-product-earphones.html';
const URL_ = JSON.parse(readFileSync(join(PAGES, 'manifest.json'), 'utf8')).pages.find(
  (p: { file: string }) => p.file === PAGE,
).url as string;

type HappyWindow = Window & { happyDOM: { setURL(url: string): void } };

let shown: AccessibleOutput[];
let clicks: string[];
let turn: TurnPipeline;

function loadFlipkart(): void {
  (window as unknown as HappyWindow).happyDOM.setURL(URL_);
  const html = readFileSync(join(PAGES, PAGE), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  document.head.innerHTML = html.match(/<head[^>]*>([\s\S]*)<\/head>/)?.[1] ?? '';
  document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? '';
}

// React Native Web handles presses on an ancestor of the text; record what reaches it (once:
// the body element outlives each test's page).
document.addEventListener('click', (e) => {
  clicks.push((e.target as Element).textContent?.trim() ?? '');
});

beforeEach(() => {
  shown = [];
  clicks = [];
  loadFlipkart();
  const profile = structuredClone(profileFixture) as Profile;
  profile.prefs.lang = 'en';
  turn = createTurnPipeline({
    backend: nodeBackend(process.env.ASL_E2E_BACKEND!),
    session: createSession(crypto.randomUUID()),
    getProfile: () => profile,
    getPage: () => extractPageContext(document),
    perform: (action, { confirmed }) => performAction(action, { confirmed, timeoutMs: 200 }),
    showOutput: (o) => void shown.push(o),
    showConfirmation: () => undefined,
    announce: () => undefined,
    confirmEveryAction: () => false,
  });
});

const target = (label: string) => {
  const t = extractPageContext(document).targets.find((x) => x.label === label);
  if (!t) throw new Error(`no target "${label}"`);
  return t;
};

describe('Flipkart product page (React Native Web controls), real backend with MOCK=1', () => {
  it('"Add to cart" (chip) → confirmation → yes → the Add to cart box is clicked', async () => {
    const add = target('Add to cart');
    await turn.send({ kind: 'phrase', text: 'Add to cart', phrase_id: 'add to cart' });
    expect(turn.pending?.pending_actions.map((a) => a.target_id)).toEqual([add.id]);
    expect(clicks).toEqual([]); // nothing before yes
    await turn.confirm();
    expect(clicks).toEqual(['Add to cart']);
    expect(resolveTarget(add.id, document)?.textContent?.trim()).toBe('Add to cart');
  });

  it('picking the control itself (local matcher / switch) also adds to cart with a confirmation', async () => {
    const add = target('Add to cart');
    await turn.send({ kind: 'switch', target_id: add.id });
    expect(turn.pending?.pending_actions.map((a) => a.target_id)).toEqual([add.id]);
  });

  it('"Buy now" is found but never pressed directly (rule 2)', async () => {
    await turn.send({ kind: 'switch', target_id: target('Buy now').id });
    expect(turn.pending).toBeNull();
    expect(shown.at(-1)?.summary).toMatch(/won't press that directly/);
    expect(clicks).toEqual([]);
  });

  it('other <div> controls (Specifications) can be pressed', async () => {
    await turn.send({ kind: 'switch', target_id: target('Specifications').id });
    expect(clicks).toEqual(['Specifications']);
  });
});
