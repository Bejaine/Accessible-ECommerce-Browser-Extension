import { mountApp, type App } from '@/src/core/app';
import { createRuntimeBackend, type BackendReply } from '@/src/core/backend';
import { bus } from '@/src/core/bus';
import {
  createTaskContinuity,
  requestSession,
  type ContinuityMessage,
} from '@/src/core/continuity';
import { loadLearnedAdapters } from '@/src/extract';
import {
  createProfileStore,
  loadDevicePrefs,
  PLAYBACK_COMMAND,
  TOGGLE_ASSISTANT,
} from '@/src/core/profile';

export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'manual',
  async main(ctx) {
    const store = await createProfileStore();
    const devicePrefs = await loadDevicePrefs().catch(() => undefined);
    const backend = createRuntimeBackend(
      (message) => browser.runtime.sendMessage(message) as Promise<BackendReply>,
    );
    // The in-browser mock can't recognise speech or provide voices; the app says so honestly.
    const demo = (import.meta.env.VITE_BACKEND ?? 'mock') === 'mock';
    // One shopping session for every page; an order task may continue on this page.
    const sendContinuity = (message: ContinuityMessage) => browser.runtime.sendMessage(message);
    const { session_id: sessionId, continue_task: continueTask } =
      await requestSession(sendContinuity);
    const continuity = createTaskContinuity(sendContinuity);
    // Selectors learned from earlier LLM fallbacks on this site, before the first extraction.
    await loadLearnedAdapters(browser.storage.local).catch(() => undefined);

    let app: App | null = null;
    const ui = await createShadowRootUi(ctx, {
      name: 'asl-overlay',
      position: 'inline',
      anchor: 'body',
      append: 'last',
      onMount: (container) => {
        const mount = () =>
          mountApp(container, store, bus, backend, {
            devicePrefs,
            demo,
            sessionId,
            continuity,
          });
        app = mount();
        // The whole interface follows the chosen language: remount when it changes.
        let lang = store.get().prefs.lang;
        const off = store.subscribe((next) => {
          if (next.prefs.lang === lang || !app) return;
          lang = next.prefs.lang;
          const wasOpen = app.overlay.isOpen;
          app.unmount();
          app = mount();
          if (wasOpen) app.overlay.open();
        });
        if (import.meta.env.DEV) {
          // Dynamic so production drops the module and its fixture imports entirely.
          void import('@/src/core/devtools').then((m) => m.installDevHooks(bus, () => app!, store));
        }
        return off;
      },
      onRemove: (off) => {
        off?.();
        app?.unmount();
        app = null;
      },
    });
    ui.mount();
    // The previous page took an order-task step (e.g. the confirmed "Place order" click): read
    // this page and let the backend finish or verify the task.
    if (continueTask) void (app as App | null)?.turn.continueTask();

    // Keyboard shortcut (Alt+Shift+A, from the background script): open or close from anywhere.
    browser.runtime.onMessage.addListener((msg: { type?: string }) => {
      if (msg?.type === TOGGLE_ASSISTANT) app?.toggleAssistant();
      if (msg?.type === PLAYBACK_COMMAND) app?.playbackKey();
      return undefined;
    });
  },
});
