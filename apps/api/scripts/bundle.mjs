// `pnpm --filter @proctor/api build`: bundles the server into dist/server.mjs for Vercel.
// Vercel runs the compiled files with plain Node, which cannot resolve the extensionless imports
// used here or load @proctor/core's TypeScript source; one bundle has neither problem.
// pdfkit stays external: it reads its built-in font files from its own folder at runtime.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [join(root, 'src', 'server.ts')],
  outfile: join(root, 'dist', 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['pdfkit'],
  // Bundled CommonJS dependencies call require(); give them one in the ES module output.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
