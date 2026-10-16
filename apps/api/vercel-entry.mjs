// Vercel entrypoint (vercel.json). Vercel checks that the entrypoint exists before building, so
// it cannot point at dist/ directly; this file loads the bundle that `pnpm build` creates
// (scripts/bundle.mjs) during the build, and re-exports its request handler.
export { default } from './dist/server.mjs';
