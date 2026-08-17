import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Path aliases must mirror tsconfig.json paths for Vite to resolve workspace packages
      '@dag/graph-core': resolve(__dirname, '../../packages/graph-core/src/index.ts'),
      '@dag/contracts': resolve(__dirname, '../../packages/contracts/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    // Proxy API calls to the Express control plane during development
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
