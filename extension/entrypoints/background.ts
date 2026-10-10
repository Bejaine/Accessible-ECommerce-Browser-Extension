import { createBackend } from '@/src/core/backend';

// Backend calls run here, not in the page, so page CSPs don't apply.
export default defineBackground(() => {
  const backend = createBackend();
  browser.runtime.onMessage.addListener((msg: { type?: string }) => {
    if (msg.type === 'health') return backend.health();
    return undefined;
  });
});
