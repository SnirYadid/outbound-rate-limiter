import {fileURLToPath} from 'node:url';

import {defineConfig} from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the tsconfig path mapping, so the examples import the package
      // by name and the README can quote them verbatim.
      'outbound-rate-limiter': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.spec.ts'],
    // Real time must never be needed. A suite that hangs is a suite that
    // reached for a real timer, and it should fail rather than stall CI.
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Type-only module: it emits no runtime statements, so it can only ever
      // report 0% and would drag the real figure down.
      exclude: ['src/types.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
});
