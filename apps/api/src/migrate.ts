import { runMigrations } from './db/client';

// `pnpm --filter @proctor/api migrate`: applies the SQL migrations and exits. Serverless hosts
// (SERVERLESS=true, e.g. Vercel) run this at build time instead of on server start.
// DATABASE_URL_UNPOOLED (set by the Neon integration) is preferred: migrations need a direct
// connection rather than a transaction-mode pooler.

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
await runMigrations(url);
console.log('migrations applied');
