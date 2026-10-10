import { crx } from '@crxjs/vite-plugin';
import { defaultClientConditions, defineConfig } from 'vite';
import manifest from './manifest.config.ts';
import { parseExtensionConfig } from './src/config.ts';

export default defineConfig({
  plugins: [crx({ manifest })],
  resolve: {
    // onnxruntime-web: load the wasm runtime from vendor/onnx (wasmPaths) instead of letting the
    // bundler emit a second 14 MB copy of it into assets/.
    conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions],
  },
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
