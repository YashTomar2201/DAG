import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // graph-core has zero deps — no special environment needed
    environment: 'node',
  },
});
