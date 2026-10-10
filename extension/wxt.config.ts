import { resolve } from 'node:path';
import { defineConfig } from 'wxt';

// MV3 for both Chrome desktop and Firefox (incl. Firefox for Android).
export default defineConfig({
  manifestVersion: 3,
  alias: {
    '@shared': resolve(__dirname, '../shared/generated/ts'),
    '@fixtures': resolve(__dirname, '../fixtures'),
  },
  manifest: ({ browser }) => ({
    name: 'Accessible Shopping Layer',
    description: 'Voice-first, accessible shopping on Amazon.in, Flipkart and other stores.',
    permissions: ['storage'],
    host_permissions: ['http://localhost:8000/*'],
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: { id: 'accessible-shopping@megathon26.local', strict_min_version: '128.0' },
        gecko_android: { strict_min_version: '128.0' },
      },
    }),
  }),
  vite: () => ({
    // Mock mode reads ../fixtures/mocks; allow the dev server outside the package.
    server: { fs: { allow: ['..'] } },
  }),
});
