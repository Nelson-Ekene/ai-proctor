import { defineConfig } from 'vite';

// Builds the SDK as a single ES module for host pages (build/proctor-sdk.js).
export default defineConfig({
  build: {
    outDir: 'build',
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'proctor-sdk' },
    sourcemap: true,
  },
});
