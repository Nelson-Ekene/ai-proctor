// Shared by playwright.config.ts and the extension fixture (fixtures.ts).
export const CI = Boolean(process.env.CI);

/** Trace policy: keep traces of failures locally; trace the first retry in CI. */
export const TRACE_MODE = CI ? 'on-first-retry' : 'retain-on-failure';
export const ACTION_TIMEOUT_MS = 15_000;
export const NAVIGATION_TIMEOUT_MS = 20_000;
