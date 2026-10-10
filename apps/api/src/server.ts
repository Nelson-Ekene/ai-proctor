import { buildApp } from './app';
import { loadConfig } from './config';
import { connect, runMigrations } from './db/client';
import { runRetention } from './retention';
import { createS3Storage } from './storage';

// Entry point: `pnpm --filter @proctor/api dev` (reads apps/api/.env if present).

const config = loadConfig();
await runMigrations(config.DATABASE_URL);
const database = connect(config.DATABASE_URL);
const storage = createS3Storage({
  endpoint: config.S3_ENDPOINT,
  publicEndpoint: config.S3_PUBLIC_ENDPOINT,
  region: config.S3_REGION,
  bucket: config.S3_BUCKET,
  accessKeyId: config.S3_ACCESS_KEY,
  secretAccessKey: config.S3_SECRET_KEY,
});
await storage.ensureBucket();

const app = await buildApp({
  config,
  db: database.db,
  storage,
  now: () => new Date(),
  logger: true,
});

let retentionRunning = false;
async function retention(): Promise<void> {
  if (retentionRunning) return;
  retentionRunning = true;
  try {
    const result = await runRetention(database.db, storage, new Date(), (m) => {
      app.log.warn(m);
    });
    if (result.sessionsDeleted > 0 || result.failures > 0) app.log.info({ retention: result });
  } catch (error) {
    app.log.error(error, 'retention run failed');
  } finally {
    retentionRunning = false;
  }
}
const timer = setInterval(() => void retention(), config.RETENTION_INTERVAL_MS);
void retention();

async function shutdown(): Promise<void> {
  clearInterval(timer);
  await app.close();
  await database.close();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await app.listen({ port: config.PORT, host: config.HOST });
