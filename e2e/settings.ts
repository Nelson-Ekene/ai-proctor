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
