import { defineConfig } from '@playwright/test';
import { ACTION_TIMEOUT_MS, CI, NAVIGATION_TIMEOUT_MS, TRACE_MODE } from './settings.ts';

// Full-stack e2e: the built extension against the demo exam site and the real API (behind a
// recording proxy), Postgres and MinIO. Privacy (data minimisation) and performance budgets.
const runId = (process.env.PW_RUN_ID ??= new Date().toISOString().replace(/[:.]/g, '-'));

export default defineConfig({
  testDir: './fullstack',
  workers: 1,
  fullyParallel: false,
  timeout: 300_000,
  expect: { timeout: 15_000 },
  retries: CI ? 1 : 0,
  outputDir: `test-results/fullstack-${runId}`,
  reporter: [
    [process.env.PW_QUIET ? 'dot' : 'list'],
    ['html', { open: 'never', outputFolder: `playwright-report/fullstack-${runId}` }],
    ['json', { outputFile: `playwright-report/fullstack-${runId}/results.json` }],
  ],
  globalSetup: './fullstack-setup.ts',
  use: {
    trace: TRACE_MODE,
    actionTimeout: ACTION_TIMEOUT_MS,
    navigationTimeout: NAVIGATION_TIMEOUT_MS,
  },
});
