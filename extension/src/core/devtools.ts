// Dev-only console hooks (`make ext` builds; stripped from production by import.meta.env.DEV).
// In DevTools, pick the extension's content-script context in the console's context dropdown,
// then e.g. `__asl.show('reviews')`, `__asl.scan('product')`, `__asl.announce('Added to cart')`.
// Everything comes from fixtures/mocks: nothing here invents data.
import type { AccessibleOutput, ActionTarget, PageType, TurnRequest } from '@shared/index';
import searchPage from '@fixtures/mocks/PageContext.search.json';
import turnRequest from '@fixtures/mocks/TurnRequest.json';
import type { InferredCondition, SignalKind } from '../infer/scores';
import { createDebugPanel, type DebugPanel } from '../ui/debugPanel';
import type { App } from './app';
import { createMockBackend } from './backend';
import type { Bus } from './bus';
import type { ProfileStore } from './profile';

const SOURCES = ['overview', 'specs', 'reviews', 'images', 'turn'] as const;
type Source = (typeof SOURCES)[number];

const PAGES = {
  product: turnRequest.page.targets as ActionTarget[],
  search: searchPage.targets as ActionTarget[],
};

async function mockOutput(name: Source): Promise<AccessibleOutput | null> {
  const backend = createMockBackend();
  if (name === 'turn') {
    // The fixture request, asking to add to cart: the mock answers with the confirmation.
    const request = turnRequest as unknown as TurnRequest;
    return (
      await backend.turn({ ...request, input: { ...request.input, phrase_id: 'add_to_cart' } })
    ).output;
  }
  if (name === 'reviews') return backend.summarizeReviews({} as never);
  return (await backend.prepareProduct({} as never)).sections[name];
}

/** Synthetic evidence for exercising the suggestion flow (dev only; real use relies on collectors). */
const SIMULATE: Record<InferredCondition, SignalKind[]> = {
  visual: ['click_without_pointer', 'contrast_setting'],
  motor: ['repeat_click', 'near_miss'],
  speech: ['unheard_speech', 'low_confidence'],
  ageing: ['hesitation', 'long_hover', 'help_use'],
};

export function installDevHooks(bus: Bus, getApp: () => App, store: ProfileStore): void {
  let debug: DebugPanel | null = null;
  const hooks = {
    sources: SOURCES,
    async show(name: Source = 'reviews') {
      const output = await mockOutput(name);
      if (output) bus.emit({ type: 'output', output });
      return output ? `showing ${name}` : `fixture has no ${name} section`;
    },
    announce(text: string, assertive = false) {
      bus.emit({ type: 'announce', text, assertive });
    },
    /** Switch scanning over a fixture page's targets. Press your switch key (default Space). */
    scan(page: keyof typeof PAGES = 'product') {
      getApp().overlay.open();
      getApp().controls.showPhrases(page);
      getApp().controls.startScanning(PAGES[page]);
      return `scanning ${page} targets`;
    },
    stopScan() {
      getApp().controls.stopScanning();
    },
    phrases(context: PageType | 'confirm' = 'product') {
      getApp().overlay.open();
      getApp().controls.showPhrases(context);
    },
    /** Show or hide the live inference scores in the overlay. */
    debug(show = true) {
      debug?.dispose();
      debug?.element.remove();
      debug = null;
      if (!show) return 'debug panel hidden';
      debug = createDebugPanel(getApp().engine, (c) => store.get().conditions[c].active);
      getApp().overlay.content.after(debug.element);
      getApp().overlay.open();
      return 'debug panel shown';
    },
    /**
     * Feed synthetic evidence, then check. 'keyboard' = keyboard-only use (fits visual and
     * motor, so it should trigger the question, not a suggestion). Suggestions are >= 60 s apart.
     */
    simulate(what: InferredCondition | 'keyboard' = 'motor') {
      const kinds: SignalKind[] = what === 'keyboard' ? ['click_without_pointer'] : SIMULATE[what];
      for (let i = 0; i < 20; i++) kinds.forEach((k) => getApp().engine.add(k));
      getApp().suggester.check();
      return getApp().suggester.state;
    },
    /** Type an utterance as if spoken: local commands first, else a turn (mock backend). */
    say(text: string) {
      getApp().overlay.open();
      return getApp().say(text);
    },
    /** Recorded signals for calibration sessions (stays on this device). */
    signals() {
      return getApp().engine.log.map((s) => ({ kind: s.kind, at: Math.round(s.at) }));
    },
    /** Turn every condition off again. */
    async resetProfile() {
      await store.update((p) => {
        for (const c of ['visual', 'speech', 'motor', 'ageing'] as const)
          p.conditions[c].active = false;
      });
      getApp().engine.reset();
      return 'conditions off, scores cleared';
    },
  };
  bus.on('followup', (m) => console.info('[asl] followup chosen:', m.text));
  bus.on('phrase', (m) => console.info('[asl] phrase chosen:', m.id, m.text));
  bus.on('select-target', (m) =>
    console.info('[asl] target selected:', m.target.id, m.target.label),
  );
  (globalThis as { __asl?: typeof hooks }).__asl = hooks;
  console.info(
    '[asl] dev hooks ready: __asl.show, scan, stopScan, phrases, announce, debug, simulate, say, signals, resetProfile',
  );
}
