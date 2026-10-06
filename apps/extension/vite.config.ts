import { crx } from '@crxjs/vite-plugin';
import { defineConfig } from 'vite';
import manifest from './manifest.config.ts';
import { parseExtensionConfig } from './src/config.ts';

export default defineConfig({
  plugins: [crx({ manifest })],
  define: {
    __PROCTOR_CONFIG__: JSON.stringify(parseExtensionConfig(process.env)),
  },
  build: {
    outDir: 'build',
    emptyOutDir: true,
    rollupOptions: {
      // Extension pages not referenced from the manifest.
      input: {
        consent: 'src/pages/consent.html',
        setup: 'src/pages/setup.html',
        offscreen: 'src/offscreen/offscreen.html',
      },
    },
  },
});
