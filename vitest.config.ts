import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each workspace is its own Vitest project; per-package config can be added later
    // (e.g. jsdom for dashboard/ui).
    projects: ['packages/*', 'apps/*'],
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      reporter: ['text', 'json-summary'],
      // CLAUDE.md: pure logic in packages/core is 100% unit tested.
      thresholds: {
        'packages/core/src/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
      },
    },
  },
});
