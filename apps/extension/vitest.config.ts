import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so unit tests never load the crx build plugin.
export default defineConfig({
  test: { environment: 'node' },
});
