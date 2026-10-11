import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ActionTarget, ProductJSON } from '@shared/index';
import productFixture from '../../fixtures/mocks/ProductJSON.json';
import turnRequest from '../../fixtures/mocks/TurnRequest.json';
import type { Mic } from '../src/audio/mic';
import { mountApp, type App } from '../src/core/app';
import { createMockBackend } from '../src/core/backend';
import { createBus } from '../src/core/bus';
import { setConditionActive } from '../src/core/composer';
import { createProfileStore } from '../src/core/profile';
import { recordingSpeaker } from './helpers/fakeSpeaker';
import { createActionMenu, PER_ZONE } from '../src/ui/actionMenu';
import { createColourLabels } from '../src/ui/colourLabels';
import { renderSimpleView, simpleSummary } from '../src/ui/simpleView';

const product = productFixture as unknown as ProductJSON;
const targets = turnRequest.page.targets as ActionTarget[];

describe('action menu', () => {
  it('lists main actions first, the rest by area behind "More on this page"', () => {
    const onSelect = vi.fn();
    const menu = createActionMenu(onSelect);
    menu.render(targets);
    const toggle = menu.element.querySelector<HTMLButtonElement>('.asl-menu-toggle')!;
    expect(toggle.textContent).toBe(`Actions on this page (${targets.length})`);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    expect(menu.element.querySelector('h3')?.textContent).toBe('Main actions');
    const main = [...menu.element.querySelectorAll('.asl-actions-menu > section li button')].map(
      (b) => b.textContent,
    );
    expect(main).toEqual(['Midnight Black', 'Sage Green', 'Quantity', 'Add to Cart', 'Buy Now']);
    const more = [...menu.element.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.startsWith('More on this page'),
    )!;
    expect(more.textContent).toBe('More on this page (2)');
    more.click();
    expect([...menu.element.querySelectorAll('h4')].map((h) => h.textContent)).toEqual([
      'Cart',
      'Search',
    ]);
    const swatch = [...menu.element.querySelectorAll('li button')].find((b) =>
      b.textContent?.startsWith('Sage Green'),
    ) as HTMLButtonElement;
    swatch.click();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 't-swatch-green' }));
  });

  it('one entry per destination, no price- or count-only labels, addresses shown as text', () => {
    const base = targets[6]!; // a link in the cart zone
    const link = (id: string, label: string, zone = 'results'): ActionTarget => ({
      ...base,
      id,
      label,
      zone: zone as ActionTarget['zone'],
    });
    const hrefs: Record<string, string> = {
      a: '/Zentra-Pulse/dp/B0X/ref=sr_1_1?q=phone',
      b: '/Zentra-Pulse/dp/B0X/ref=sr_1_1_img',
      c: '/Zentra-Pulse/dp/B0X#reviews',
      d: '/Other/dp/B0Y',
    };
    const menu = createActionMenu(vi.fn(), {
      hrefOf: (id) => hrefs[id] ?? null,
      display: (text) => text.replace('ADDR_1', 'Flat 4, MG Road'),
    });
    menu.render([
      link('a', 'Zentra'),
      link('b', 'Zentra Pulse 5G (8 GB RAM, 128 GB)'), // same product, better label: kept
      link('c', '4.2 out of 5 stars'),
      link('d', 'Other phone'),
      link('p', '₹13,999'),
      link('r', '21,106 ratings'),
      link('n', '8,263'),
      link('k', '+7 other colors/patterns'),
      link('addr', 'Delivering to ADDR_1', 'product'),
    ]);
    expect(menu.actions.map((t) => t.label)).toEqual([
      'Delivering to ADDR_1',
      'Zentra Pulse 5G (8 GB RAM, 128 GB)',
      'Other phone',
    ]);
    menu.element.querySelector<HTMLButtonElement>('.asl-menu-toggle')!.click();
    expect(menu.element.textContent).toContain('Delivering to Flat 4, MG Road');
    expect(menu.element.textContent).not.toContain('ADDR_1');
  });

  it('shows an area in pages and never lists disabled targets', () => {
    const many: ActionTarget[] = Array.from({ length: PER_ZONE + 3 }, (_, i) => ({
      ...targets[6]!,
      id: `t${i}`,
      label: `Item ${i}`,
    }));
    many.push({
      ...targets[6]!,
      id: 'off',
      label: 'Disabled',
      state: { disabled: true, selected: false, expanded: false },
    });
    const menu = createActionMenu(vi.fn());
    menu.render(many);
    menu.element.querySelector<HTMLButtonElement>('.asl-menu-toggle')!.click();
    expect(menu.element.querySelectorAll('li')).toHaveLength(PER_ZONE);
    expect(menu.element.textContent).not.toContain('Disabled');
    [...menu.element.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === 'Show 3 more')!
      .click();
    expect(menu.element.querySelectorAll('li')).toHaveLength(PER_ZONE + 3);
  });
});

describe('colour labels', () => {
  it('labels named swatches next to them without touching the page, and announces on focus', async () => {
    document.body.innerHTML = '<button id="g">swatch</button><button id="b">no name</button>';
    const g = document.getElementById('g')!;
    g.getBoundingClientRect = () =>
      ({ left: 40, top: 100, right: 80, bottom: 140, width: 40, height: 40 }) as DOMRect;
    const host = document.createElement('div');
    document.body.append(host);
    const labels = createColourLabels(host, (id) =>
      id === 't-swatch-green' ? g : document.getElementById('b'),
    );
    labels.render([...targets, { ...targets[1]!, id: 'unnamed', colour_name: null }]);
    const tags = [...host.querySelectorAll('.asl-colour-label')] as HTMLElement[];
    // Both named swatches get a label; the unnamed one is left alone (no guessing).
    expect(tags.map((t) => t.textContent)).toEqual(['Midnight Black', 'Sage Green']);
    expect(tags[1]!.style.left).toBe('40px');
    expect(host.querySelector('.asl-colour-layer')?.getAttribute('aria-hidden')).toBe('true');
    expect(g.textContent).toBe('swatch'); // the shop's element is unchanged
    labels.destroy();
    expect(host.querySelector('.asl-colour-layer')).toBeNull();
  });
});

describe('simplified view', () => {
  it('shows only ProductJSON facts, says when the page does not list one, and has big actions', () => {
    const onSelect = vi.fn();
    const view = renderSimpleView(product, targets, { onSelect, onBack: vi.fn(), maxActions: 3 });
    expect(view.querySelector('h3')?.textContent).toBe(product.title);
    expect(view.querySelector('.asl-price')?.textContent).toBe('₹17,999');
    expect(view.textContent).toContain('₹24,999 (you save ₹7,000)');
    expect(view.textContent).toContain('4.2 out of 5 from 3,418 ratings');
    expect(view.querySelectorAll('ul')[0]!.children).toHaveLength(5);
    const actions = [...view.querySelectorAll<HTMLButtonElement>('.asl-big button')];
    expect(actions.map((b) => b.textContent)).toEqual(['Add to Cart', 'Buy Now']);
    actions[0]!.click();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 't-add-to-cart' }));

    const bare = { ...product, price: null, rating: null, seller: null };
    const sparse = renderSimpleView(bare, [], { onSelect, onBack: vi.fn(), maxActions: 3 });
    expect(sparse.querySelector('.asl-price')?.textContent).toBe(
      "Price: the page doesn't list this.",
    );
    expect(sparse.textContent).toContain("The page doesn't list this.");
    expect(simpleSummary(bare)).toContain("Price: the page doesn't list this.");
  });
});

describe('page tools in the app', () => {
  let host: HTMLElement;
  let app: App;

  afterEach(() => {
    app?.unmount();
    host?.remove();
    document.head.querySelector('script[type="application/ld+json"]')?.remove();
    vi.useRealTimers();
  });

  beforeEach(() => {
    fakeBrowser.reset();
    vi.useFakeTimers();
  });

  async function mountOnProductPage(conditions: ('ageing' | 'colour')[]) {
    const ld = document.createElement('script');
    ld.type = 'application/ld+json';
    ld.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'Example Phone',
      offers: { '@type': 'Offer', price: '9999', priceCurrency: 'INR' },
    });
    document.head.append(ld);
    document.body.innerHTML = '<main><button>Add to Cart</button></main>';
    const store = await createProfileStore();
    for (const c of conditions)
      await store.update((d) => setConditionActive(d, c, true, 'user', 1));
    host = document.createElement('div');
    const container = document.createElement('div');
    host.attachShadow({ mode: 'open' }).appendChild(container);
    document.body.appendChild(host);
    const { speaker } = recordingSpeaker();
    const mic: Mic = {
      listening: false,
      muted: false,
      listen: () => new Promise(() => undefined),
      stop: () => undefined,
      mute: () => undefined,
      unmute: () => undefined,
    };
    app = mountApp(container, store, createBus(), createMockBackend(), { speaker, mic });
  }

  it('simple mode opens straight into the simplified view on a product page; Back returns', async () => {
    await mountOnProductPage(['ageing']);
    app.overlay.open();
    const root = host.shadowRoot!;
    expect(root.querySelector('.asl-simple h3')?.textContent).toBe('Example Phone');
    expect(root.querySelector('.asl-panel')?.classList.contains('asl-wide')).toBe(true);
    [...root.querySelectorAll<HTMLButtonElement>('.asl-simple button')]
      .find((b) => b.textContent === 'Back to menu')!
      .click();
    expect(root.querySelector('.asl-simple')).toBeNull();
    expect(root.querySelector('.asl-panel')?.classList.contains('asl-wide')).toBe(false);
  });

  it('without simple mode the menu shows a "Simple view" button and the action menu', async () => {
    await mountOnProductPage([]);
    app.overlay.open();
    const root = host.shadowRoot!;
    expect(root.querySelector('.asl-simple')).toBeNull();
    const simple = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Simple view',
    )!;
    expect(simple.hidden).toBe(false);
    expect(
      [...root.querySelectorAll('button')].some((b) =>
        b.textContent?.startsWith('Actions on this page'),
      ),
    ).toBe(true);
    simple.click();
    expect(root.querySelector('.asl-simple h3')?.textContent).toBe('Example Phone');
  });
});
