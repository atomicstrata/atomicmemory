/**
 * Vitest configuration for @atomicmemory/core.
 * Disables file-level parallelism to prevent DB integration tests
 * from interfering with each other via shared schema DDL.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    fileParallelism: false,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
