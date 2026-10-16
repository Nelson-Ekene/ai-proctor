// `pnpm --filter @proctor/api build`: bundles the server into dist/server.mjs for Vercel.
// Vercel runs the compiled files with plain Node, which cannot resolve the extensionless imports
// used here or load @proctor/core's TypeScript source; one bundle has neither problem. Everything
// is bundled, because Vercel moves the bundle to a folder where node_modules cannot be found.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// pdfkit loads its standard fonts through `createRequire(import.meta.url)`, which esbuild cannot
// follow. Turning those into plain require() calls lets esbuild bundle the font modules
// (pdfkit/js/standard-fonts/*.cjs via the package's `#standard-fonts/*` import map).
const pdfkitFonts = {
  name: 'pdfkit-standard-fonts',
  setup(b) {
    b.onLoad({ filter: /[\\/]pdfkit[\\/]js[\\/]pdfkit\.node\.mjs$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      const contents = source.replaceAll(
        "require$1('#standard-fonts/",
        "require('#standard-fonts/",
      );
      if (contents === source)
        throw new Error('pdfkit font loaders not found: check pdfkit version');
      return { contents, loader: 'js' };
    });
  },
};

await build({
  entryPoints: [join(root, 'src', 'server.ts')],
  outfile: join(root, 'dist', 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  plugins: [pdfkitFonts],
  // Bundled CommonJS dependencies call require(); give them one in the ES module output.
  banner: {
    // Aliased: bundled modules (pdfkit) import createRequire themselves.
    js: "import { createRequire as __bundleRequire } from 'node:module'; const require = __bundleRequire(import.meta.url);",
  },
  logLevel: 'info',
});
