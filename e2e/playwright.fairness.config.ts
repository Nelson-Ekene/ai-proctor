import { defineConfig } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_TIMEOUT_MS, NAVIGATION_TIMEOUT_MS } from './settings.ts';

// Fairness harness (BUILD_PLAN Phase 9.2): runs the bundled models on fixture images under
// varied conditions through the diagnostics build of the extension (never shipped).
const here = dirname(fileURLToPath(import.meta.url));
process.env.PW_EXTENSION_PATH ??= join(here, '..', 'apps', 'extension', 'build-diagnostics');
const runId = (process.env.PW_RUN_ID ??= new Date().toISOString().replace(/[:.]/g, '-'));

export default defineConfig({
  testDir: './fairness',
  workers: 1,
  timeout: 300_000,
  outputDir: `test-results/fairness-${runId}`,
  reporter: [
    [process.env.PW_QUIET ? 'dot' : 'list'],
    ['json', { outputFile: `playwright-report/fairness-${runId}/results.json` }],
  ],
  globalSetup: './fairness-setup.ts',
  use: { actionTimeout: ACTION_TIMEOUT_MS, navigationTimeout: NAVIGATION_TIMEOUT_MS },
});
