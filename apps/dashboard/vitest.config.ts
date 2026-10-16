import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so unit tests never load Tailwind or the dev proxy.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Whole-app tests that type into the policy form take ~1 s alone but exceeded the 5 s
    // default when the full workspace suite (API containers included) ran in parallel.
    testTimeout: 15_000,
  },
});
