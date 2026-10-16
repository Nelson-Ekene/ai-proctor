import { encodeWav, type Anomaly, type EvidenceRef, type Policy } from '@proctor/core';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { expect, inject } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { connect, runMigrations, type Db } from '../src/db/client';
import { apiKeys, organisations, users } from '../src/db/schema';
import { hashPassword, hashToken, newToken } from '../src/security';
import { createS3Storage, type EvidenceStorage } from '../src/storage';

export const PASSWORD = 'correct horse battery staple';

export interface Org {
  id: string;
  apiKey: string;
  adminToken: string;
  reviewerToken: string;
}

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  storage: EvidenceStorage;
  clock: { now: Date; advance(ms: number): void };
  orgA: Org;
  orgB: Org;
  close(): Promise<void>;
}

/** Hashed once per file: scrypt is deliberately slow. */
let passwordHash: Promise<string> | undefined;

/** A fresh database + bucket + app, with two organisations (A and B) each having users and a key. */
export async function createTestContext(env: Record<string, string> = {}): Promise<TestContext> {
  const suffix = randomBytes(6).toString('hex');
  const baseUrl = inject('databaseUrl');
  const admin = postgres(baseUrl, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`create database "t_${suffix}"`);
  await admin.end();
  const url = new URL(baseUrl);
  url.pathname = `/t_${suffix}`;
  const databaseUrl = url.toString();
  await runMigrations(databaseUrl);

  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    S3_ENDPOINT: inject('s3Endpoint'),
    S3_BUCKET: `evidence-${suffix}`,
    S3_ACCESS_KEY: inject('s3AccessKey'),
    S3_SECRET_KEY: inject('s3SecretKey'),
    ...env,
  });
  const database = connect(databaseUrl);
  const storage = createS3Storage({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  });
  await storage.ensureBucket();

  const clock = {
    now: new Date('2026-10-01T09:00:00Z'),
    advance(ms: number) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
  const app = await buildApp({ config, db: database.db, storage, now: () => clock.now });

  const ctx = { app, db: database.db, storage, clock };
  const orgA = await createOrg(ctx, 'a');
  const orgB = await createOrg(ctx, 'b');
  return {
    ...ctx,
    orgA,
    orgB,
    async close() {
      await app.close();
      await database.close();
    },
  };
}

async function createOrg(ctx: Pick<TestContext, 'app' | 'db'>, name: string): Promise<Org> {
  const [org] = await ctx.db.insert(organisations).values({ name }).returning();
  if (!org) throw new Error('no org');
  passwordHash ??= hashPassword(PASSWORD);
  const hash = await passwordHash;
  await ctx.db.insert(users).values([
    { organisationId: org.id, email: `admin@${name}.test`, passwordHash: hash, role: 'admin' },
    {
      organisationId: org.id,
      email: `reviewer@${name}.test`,
      passwordHash: hash,
      role: 'reviewer',
    },
  ]);
  const apiKey = newToken('api_key');
  await ctx.db
    .insert(apiKeys)
    .values({ organisationId: org.id, label: 'test', keyHash: hashToken(apiKey) });
  return {
    id: org.id,
    apiKey,
    adminToken: await login(ctx.app, `admin@${name}.test`),
    reviewerToken: await login(ctx.app, `reviewer@${name}.test`),
  };
}

export async function login(
  app: FastifyInstance,
  email: string,
  password = PASSWORD,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ token: string }>().token;
}

export function call(
  app: FastifyInstance,
  token: string | undefined,
  options: InjectOptions,
): Promise<LightMyRequestResponse> {
  return app.inject({
    ...options,
    headers: { ...options.headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
}

export interface StartedSession {
  sessionId: string;
  token: string;
  policySnapshot: Policy;
}

export async function startSession(
  ctx: Pick<TestContext, 'app'>,
  org: Org,
  body: { candidateRef?: string; examId?: string } = {},
): Promise<StartedSession> {
  const res = await call(ctx.app, org.apiKey, {
    method: 'POST',
    url: '/v1/sessions',
    payload: { candidateRef: 'cand-1', ...body },
  });
  expect(res.statusCode).toBe(201);
  const json = res.json<{ sessionId: string; sessionToken: string; policySnapshot: Policy }>();
  return {
    sessionId: json.sessionId,
    token: json.sessionToken,
    policySnapshot: json.policySnapshot,
  };
}

let seq = 0;
/** A unique client id, like the extension's crypto.randomUUID(). */
export function id(prefix: string): string {
  seq += 1;
  return `${prefix}-${String(seq)}-${randomBytes(4).toString('hex')}`;
}

/** An anomaly as the extension uploads it (always with an event sequence). */
export function anomaly(
  type: Anomaly['type'],
  ts: number,
  confidence = 1,
  extra: EvidenceRef[] = [],
): Anomaly {
  return {
    id: id('anomaly'),
    type,
    ts,
    confidence,
    evidence: [{ id: id('seq'), kind: 'event_sequence', ts }, ...extra],
  };
}

export function postAnomaly(
  ctx: Pick<TestContext, 'app'>,
  s: StartedSession,
  a: Anomaly,
  key = a.id,
): Promise<LightMyRequestResponse> {
  return call(ctx.app, s.token, {
    method: 'POST',
    url: `/v1/sessions/${s.sessionId}/anomalies`,
    headers: { 'idempotency-key': key },
    payload: a,
  });
}

export function putEvidence(
  ctx: Pick<TestContext, 'app'>,
  s: StartedSession,
  evidenceId: string,
  contentType: string,
  body: Buffer | string,
): Promise<LightMyRequestResponse> {
  return call(ctx.app, s.token, {
    method: 'PUT',
    url: `/v1/sessions/${s.sessionId}/evidence/${encodeURIComponent(evidenceId)}`,
    headers: { 'content-type': contentType, 'idempotency-key': evidenceId },
    payload: body,
  });
}

/** A minimal JPEG-looking body (SOI marker + filler) and a real WAV. */
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(256)]);
export const WAV = Buffer.from(encodeWav(new Float32Array(1600), 16_000));
