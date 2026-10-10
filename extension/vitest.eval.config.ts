import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// Evaluation scripts in ../eval (not part of `make check`).
export default defineConfig({
  plugins: [WxtVitest()],
  test: { include: ['../eval/**/*.eval.ts'], environment: 'node' },
});
