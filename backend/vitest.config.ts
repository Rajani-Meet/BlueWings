import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup.ts'],
    // Flows share DB state within a file; run files serially for determinism.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
