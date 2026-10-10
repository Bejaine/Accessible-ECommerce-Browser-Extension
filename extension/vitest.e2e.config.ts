import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// Persona runs on MockMart against the real backend (`make e2e`; not part of `make check`).
export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    include: [resolve(__dirname, '../eval/e2e/*.e2e.ts')],
    environment: 'happy-dom',
    globalSetup: [resolve(__dirname, '../eval/e2e/backend.setup.ts')],
    fileParallelism: false,
  },
});
