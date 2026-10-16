import { z } from 'zod';

// Server configuration from the environment. Product thresholds are NOT here: they come from
// the policy object (packages/core). These are deployment and security settings.

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  /** Prepared statements. Turn off behind a transaction-mode pooler (Neon/Supabase pooled URL). */
  DB_PREPARE: z.stringbool().default(true),
  /**
   * Serverless host (on by default when VERCEL is set): nothing runs between requests, so the
   * server skips migrations on start (run `pnpm --filter @proctor/api migrate` at build) and the
   * retention timer (a scheduler must call GET /v1/internal/retention instead).
   */
  SERVERLESS: z.stringbool().default(false),
  /** Bearer secret for GET /v1/internal/retention (e.g. sent by Vercel Cron). Unset: route is off. */
  CRON_SECRET: z.string().min(16).optional(),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1).default('evidence'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  /** Endpoint used in signed URLs given to reviewers' browsers (defaults to S3_ENDPOINT). */
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  /** Lifetime of a candidate session token issued to the extension. */
  SESSION_TOKEN_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(12 * 60 * 60 * 1000),
  /** Lifetime of a reviewer/admin login token. */
  USER_TOKEN_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 60 * 60 * 1000),
  /** Lifetime of a signed evidence URL handed to a reviewer. */
  EVIDENCE_URL_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  /** How often the retention job runs. */
  RETENTION_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 1000),
  /**
   * Largest evidence body accepted (frames are ~50 KB, a 30 s WAV ~1 MB). Kept under Vercel's
   * 4.5 MB request limit.
   */
  MAX_EVIDENCE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(4 * 1024 * 1024),
  /** Failed logins (same e-mail and address) allowed per LOGIN_WINDOW_MS before a pause. */
  LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(10),
  LOGIN_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  /** Origins allowed to call reviewer/admin routes from a browser (dashboard). */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return ConfigSchema.parse({ SERVERLESS: env.VERCEL ? 'true' : undefined, ...env });
}
