import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@amem/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@amem/db': fileURLToPath(new URL('../db/src/index.ts', import.meta.url)),
    },
  },
});
