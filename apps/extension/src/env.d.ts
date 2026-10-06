import type { ExtensionConfig } from './config';

declare global {
  /** Injected at build time by vite.config.ts from PROCTOR_* environment variables. */
  const __PROCTOR_CONFIG__: ExtensionConfig;
}
