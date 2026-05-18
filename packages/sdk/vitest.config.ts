import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/__tests__/**/*.test.ts'],
    coverage: {
      // `fallow audit --coverage` needs Istanbul-format coverage-final.json;
      // v8/c8 native isn't supported. Keep `text` for CI logs, `html` for
      // local browsing, `json` for the coverage-final.json fallow reads.
      provider: 'istanbul',
      reporter: ['text', 'html', 'json'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.d.ts'],
    },
  },
});
