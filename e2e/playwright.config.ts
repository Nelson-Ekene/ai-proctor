import { defineConfig } from '@playwright/test';
import { ACTION_TIMEOUT_MS, CI, NAVIGATION_TIMEOUT_MS, TRACE_MODE } from './settings.ts';

// One id per `playwright test` invocation. Stored in the environment so worker processes (which
// re-evaluate this file) resolve the same folders as the main process.
const runId = (process.env.PW_RUN_ID ??= new Date().toISOString().replace(/[:.]/g, '-'));

const RESULTS_ROOT = 'test-results';
const REPORTS_ROOT = 'playwright-report';

export default defineConfig({
  testDir: './tests',
  // One extension instance and fixed mock-server ports: run serially.
  workers: 1,
  fullyParallel: false,
  // Explicit budgets so a hang fails fast instead of stalling the suite.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: CI ? 1 : 0,
  // Each run writes to its own folder, so artifacts are never wiped by the next run.
  outputDir: `${RESULTS_ROOT}/${runId}`,
  reporter: [
    [process.env.PW_QUIET ? 'dot' : 'list'],
    ['html', { open: 'never', outputFolder: `${REPORTS_ROOT}/${runId}` }],
    ['json', { outputFile: `${REPORTS_ROOT}/${runId}/results.json` }],
  ],
  globalSetup: './global-setup.ts',
  // Applies to contexts Playwright creates; the extension fixture mirrors these by hand.
  use: {
    trace: TRACE_MODE,
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: ACTION_TIMEOUT_MS,
    navigationTimeout: NAVIGATION_TIMEOUT_MS,
  },
  webServer: {
    command: 'pnpm exec tsx mock-server.ts',
    url: 'http://localhost:4401/__test/state',
    reuseExistingServer: !CI,
    stdout: 'pipe',
  },
});
