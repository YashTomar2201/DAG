import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests require a real Postgres DB via DATABASE_URL.
    // describe.skipIf(!HAS_DB) in the test file handles the guard gracefully.
    environment: 'node',
    testTimeout: 30_000,
  },
});
