import { defineConfig } from 'vitest/config';

// Integration tests run against real Postgres and MinIO containers (testcontainers; Docker
// required). Containers start once per run in test/global-setup.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
