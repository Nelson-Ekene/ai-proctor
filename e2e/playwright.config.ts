import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // One extension instance and fixed mock-server ports: run serially.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm exec tsx mock-server.ts',
    url: 'http://localhost:4401/__test/state',
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
  },
});
