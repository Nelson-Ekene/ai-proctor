import { join } from 'node:path';
import {
  DASHBOARD_API_PORT,
  DASHBOARD_API_URL,
  DASHBOARD_PORT,
  DASHBOARD_URL,
  SEED_PASSWORD,
} from './settings.ts';
import { DASHBOARD_DIR, startStack, waitForUrl } from './stack.ts';

// Real stack for the dashboard e2e test: Postgres + MinIO containers, the API server, the demo
// seed (same ingestion code as real uploads) and the dashboard's Vite dev server. Docker needed.

export default async function setup(): Promise<() => Promise<void>> {
  const stack = await startStack({
    apiPort: DASHBOARD_API_PORT,
    seedPassword: SEED_PASSWORD,
    demo: true,
  });
  try {
    const vite = stack.start(
      'dashboard',
      [
        join(DASHBOARD_DIR, 'node_modules', 'vite', 'bin', 'vite.js'),
        '--port',
        String(DASHBOARD_PORT),
        '--strictPort',
      ],
      DASHBOARD_DIR,
      { PROCTOR_API_URL: DASHBOARD_API_URL },
    );
    await waitForUrl(DASHBOARD_URL, 60_000, vite);
  } catch (error) {
    await stack.teardown();
    throw error;
  }
  return stack.teardown;
}
