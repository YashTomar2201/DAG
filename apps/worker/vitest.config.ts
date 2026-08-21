import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Python bridge tests can take a few seconds to spawn a subprocess
    testTimeout: 30_000,
    setupFiles: ['./src/test.setup.ts'],
  },
});
