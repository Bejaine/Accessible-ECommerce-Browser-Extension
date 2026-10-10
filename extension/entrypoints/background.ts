import {
  createBackend,
  handleBackendMessage,
  type BackendRequestMessage,
} from '@/src/core/backend';
import {
  ASSISTANT_COMMAND,
  isOnboarded,
  OPEN_ONBOARDING,
  TOGGLE_ASSISTANT,
} from '@/src/core/profile';

function openOnboarding() {
  return browser.tabs.create({ url: browser.runtime.getURL('/onboarding.html') });
}

// Backend calls run here, not in the page, so page CSPs don't apply. The content script relays
// them with createRuntimeBackend(); see src/core/backend.ts. First-run setup opens once, on
// install, in its own tab (never on shop pages); Settings can open it again.
export default defineBackground(() => {
  const backend = createBackend();
  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason === 'install' && !(await isOnboarded())) await openOnboarding();
  });
  // Keyboard shortcut: open or close the assistant in the active tab.
  browser.commands.onCommand.addListener(async (command) => {
    if (command !== ASSISTANT_COMMAND) return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined)
      await browser.tabs.sendMessage(tab.id, { type: TOGGLE_ASSISTANT }).catch(() => undefined);
  });
  browser.runtime.onMessage.addListener(
    (msg: Partial<BackendRequestMessage> | { type?: string }) => {
      if (msg?.type === OPEN_ONBOARDING) return openOnboarding().then(() => true);
      if (msg?.type === 'backend' && 'method' in msg && msg.method) {
        return handleBackendMessage(backend, msg as BackendRequestMessage);
      }
      return undefined;
    },
  );
});
