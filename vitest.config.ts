import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each workspace is its own Vitest project; per-package config can be added later
    // (e.g. jsdom for dashboard/ui, coverage thresholds for core).
    projects: ['packages/*', 'apps/*'],
  },
});
