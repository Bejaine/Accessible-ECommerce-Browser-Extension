import { mountOverlay } from '@/src/ui/overlay';

export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'manual',
  async main(ctx) {
    const ui = await createShadowRootUi(ctx, {
      name: 'asl-overlay',
      position: 'inline',
      anchor: 'body',
      onMount: (container) => mountOverlay(container),
    });
    ui.mount();
  },
});
