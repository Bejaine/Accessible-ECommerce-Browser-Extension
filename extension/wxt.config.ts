import { resolve } from 'node:path';
import { loadEnv } from 'vite';
import { defineConfig } from 'wxt';

/**
 * The backend the extension may call: localhost always, plus VITE_BACKEND's origin when it is
 * another address (e.g. the laptop's LAN IP, so Firefox for Android on a phone can reach it).
 */
function backendHosts(mode: string): string[] {
  const hosts = ['http://localhost:8000/*'];
  const setting = process.env.VITE_BACKEND ?? loadEnv(mode, __dirname, 'VITE_').VITE_BACKEND;
  try {
    const origin = setting && setting !== 'mock' ? new URL(setting).origin : null;
    if (origin && !hosts.includes(`${origin}/*`)) hosts.push(`${origin}/*`);
  } catch {
    // Not a URL: mock mode, nothing to add.
  }
  return hosts;
}

// MV3 for both Chrome desktop and Firefox (incl. Firefox for Android).
export default defineConfig({
  manifestVersion: 3,
  alias: {
    '@shared': resolve(__dirname, '../shared/generated/ts'),
    '@fixtures': resolve(__dirname, '../fixtures'),
  },
  manifest: ({ browser, mode }) => ({
    name: 'Accessible Shopping Layer',
    description: 'Voice-first, accessible shopping on Amazon.in, Flipkart and other stores.',
    permissions: ['storage'],
    commands: {
      'toggle-assistant': {
        suggested_key: { default: 'Alt+Shift+A' },
        description: 'Open or close the Shopping assistant',
      },
      'playback-key': {
        suggested_key: { default: 'Alt+Shift+K' },
        description: 'Pause or resume reading; wait for the spoken playback menu',
      },
    },
    host_permissions: backendHosts(mode),
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: { id: 'accessible-shopping@megathon26.local', strict_min_version: '128.0' },
        gecko_android: { strict_min_version: '128.0' },
      },
    }),
  }),
  // `make ext` Chrome: --test-type hides Chrome's "unsupported command-line flag" bar (web-ext adds
  // --disable-blink-features=AutomationControlled on purpose, so shops don't see a bot). On Linux,
  // Chrome is launched through dev/chrome-linux.sh, which drops one web-ext default flag that
  // removes Chrome's speech voices; other platforms use the OS voices.
  webExt: {
    chromiumArgs: ['--test-type'],
    ...(process.platform === 'linux' && {
      binaries: { chrome: resolve(__dirname, 'dev/chrome-linux.sh') },
    }),
  },
  vite: () => ({
    // Mock mode reads ../fixtures/mocks; allow the dev server outside the package.
    server: { fs: { allow: ['..'] } },
  }),
});
