import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 15_000,
    setupFiles: ['./src/test.setup.ts'],
    // Phase 12's Testcontainers suite lives in src/integration/*.integration.test.ts
    // and needs its own globalSetup (real Postgres/Redis containers) — run it via
    // `pnpm test:integration`, not the fast mocked `pnpm test` pass.
    exclude: ['**/node_modules/**', 'src/integration/**'],
  },
});
