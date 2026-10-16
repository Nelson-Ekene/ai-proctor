// Shared by playwright.config.ts, the extension fixture (fixtures.ts) and mock-server.ts.
export const CI = Boolean(process.env.CI);

/** Trace policy: keep traces of failures locally; trace the first retry in CI. */
export const TRACE_MODE = CI ? 'on-first-retry' : 'retain-on-failure';
export const ACTION_TIMEOUT_MS = 15_000;
export const NAVIGATION_TIMEOUT_MS = 20_000;

/**
 * Mock server ports. Override (e.g. 4500/4501) to run tests next to a manual mock session; the
 * extension under test must then be built with matching PROCTOR_EXAM_ORIGINS/PROCTOR_API_ORIGINS.
 */
export const HOST_PORT = Number(process.env.MOCK_HOST_PORT ?? 4400);
export const API_PORT = Number(process.env.MOCK_API_PORT ?? 4401);
export const HOST_URL = `http://localhost:${String(HOST_PORT)}`;
export const API_URL = `http://localhost:${String(API_PORT)}`;

/**
 * Dashboard e2e (real API + dashboard dev server, see dashboard-setup.ts). Ports are separate
 * from the mock server and from a manual `pnpm --filter @proctor/api dev` (4000) / dashboard (5173).
 */
export const DASHBOARD_API_PORT = Number(process.env.DASHBOARD_API_PORT ?? 4610);
export const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT ?? 4611);
export const DASHBOARD_API_URL = `http://localhost:${String(DASHBOARD_API_PORT)}`;
export const DASHBOARD_URL = `http://localhost:${String(DASHBOARD_PORT)}`;
/** Password of the seeded admin@proctor.test / reviewer@proctor.test accounts. */
export const SEED_PASSWORD = 'e2e-dashboard-password';

/**
 * Full-stack e2e (extension + demo exam site + real API behind a recording proxy, see
 * fullstack-setup.ts). The extension reaches the API through the proxy port; these origins are
 * in the extension's development defaults (apps/extension/src/config.ts).
 */
export const FULLSTACK_HOST_PORT = 4620;
export const FULLSTACK_PROXY_PORT = 4621;
export const FULLSTACK_API_PORT = Number(process.env.FULLSTACK_API_PORT ?? 4622);
export const FULLSTACK_HOST_URL = `http://localhost:${String(FULLSTACK_HOST_PORT)}`;
export const FULLSTACK_PROXY_URL = `http://localhost:${String(FULLSTACK_PROXY_PORT)}`;
export const FULLSTACK_API_URL = `http://localhost:${String(FULLSTACK_API_PORT)}`;
