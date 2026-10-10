import { defineConfig } from 'drizzle-kit';

// `pnpm --filter @proctor/api db:generate` writes SQL migrations to ./drizzle from the schema.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
