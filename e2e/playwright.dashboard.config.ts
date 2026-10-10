import { defineConfig } from '@playwright/test';
import {
  ACTION_TIMEOUT_MS,
  CI,
  DASHBOARD_URL,
  NAVIGATION_TIMEOUT_MS,
  TRACE_MODE,
} from './settings.ts';

// Dashboard e2e against the real API, database and storage (see dashboard-setup.ts). Separate
// from the extension suite: no extension, no fake camera, its own servers.
const runId = (process.env.PW_RUN_ID ??= new Date().toISOString().replace(/[:.]/g, '-'));

export default defineConfig({
  testDir: './dashboard',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: CI ? 1 : 0,
  outputDir: `test-results/dashboard-${runId}`,
  reporter: [
    [process.env.PW_QUIET ? 'dot' : 'list'],
    ['html', { open: 'never', outputFolder: `playwright-report/dashboard-${runId}` }],
    ['json', { outputFile: `playwright-report/dashboard-${runId}/results.json` }],
  ],
  globalSetup: './dashboard-setup.ts',
  use: {
    baseURL: DASHBOARD_URL,
    trace: TRACE_MODE,
    screenshot: 'only-on-failure',
    actionTimeout: ACTION_TIMEOUT_MS,
    navigationTimeout: NAVIGATION_TIMEOUT_MS,
  },
});
