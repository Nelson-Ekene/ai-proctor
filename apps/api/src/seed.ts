import { eq } from 'drizzle-orm';
import { loadConfig } from './config';
import { connect, runMigrations } from './db/client';
import { apiKeys, organisations, sessions, users } from './db/schema';
import { seedDemoSessions } from './demo';
import { REGIONS, type Region } from './regions';
import { hashPassword, hashToken, newToken } from './security';
import { createS3Storage } from './storage';

// Development seed: one organisation with an admin, a reviewer and an integrator API key.
// `pnpm --filter @proctor/api seed`. Prints the secrets once; safe to re-run (skips existing users).
// `--demo` also adds demo sessions with synthetic evidence for the dashboard (`--demo-if-empty`:
// only if the organisation has no sessions yet). SEED_REGION sets the organisation's region.

const ADMIN = 'admin@proctor.test';
const REVIEWER = 'reviewer@proctor.test';
const PASSWORD = process.env.SEED_PASSWORD ?? 'change-me-please';
const REGION = (process.env.SEED_REGION ?? 'eu') as Region;
if (!REGIONS.includes(REGION)) throw new Error(`SEED_REGION must be one of ${REGIONS.join(', ')}`);

const config = loadConfig();
await runMigrations(config.DATABASE_URL);
const database = connect(config.DATABASE_URL);
const { db } = database;
try {
  const [existing] = await db.select().from(users).where(eq(users.email, ADMIN));
  let organisationId = existing?.organisationId;
  if (!organisationId) {
    const [org] = await db
      .insert(organisations)
      .values({ name: 'Demo organisation', region: REGION })
      .returning({ id: organisations.id });
    if (!org) throw new Error('organisation insert returned no row');
    organisationId = org.id;
    const passwordHash = await hashPassword(PASSWORD);
    await db.insert(users).values([
      { organisationId, email: ADMIN, passwordHash, role: 'admin' },
      { organisationId, email: REVIEWER, passwordHash, role: 'reviewer' },
    ]);
    console.log(`users: ${ADMIN} (admin), ${REVIEWER} (reviewer), password "${PASSWORD}"`);
  } else {
    console.log('users already exist; not changed');
  }
  const key = newToken('api_key');
  await db.insert(apiKeys).values({ organisationId, label: 'seed', keyHash: hashToken(key) });
  console.log(`organisation: ${organisationId}`);
  console.log(`integrator API key (shown once): ${key}`);

  // --demo adds demo sessions; --demo-if-empty only when the organisation has none yet.
  const ifEmpty = process.argv.includes('--demo-if-empty');
  const hasSessions =
    ifEmpty &&
    (
      await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.organisationId, organisationId))
        .limit(1)
    ).length > 0;
  if ((process.argv.includes('--demo') || ifEmpty) && !hasSessions) {
    const storage = createS3Storage({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET,
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    });
    await storage.ensureBucket();
    const seeded = await seedDemoSessions(db, storage, organisationId, new Date());
    for (const s of seeded) console.log(`demo session ${s.candidateRef}: ${s.id}`);
  }
} finally {
  await database.close();
}
