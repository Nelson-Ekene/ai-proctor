import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { call, createTestContext, type TestContext } from './helpers';

const SECRET = 'cron-secret-for-tests-0123456789';
const BASE = {
  DATABASE_URL: 'postgres://x',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
};

describe('serverless config', () => {
  it('is off by default and on when VERCEL is set, unless overridden', () => {
    expect(loadConfig(BASE).SERVERLESS).toBe(false);
    expect(loadConfig({ ...BASE, VERCEL: '1' }).SERVERLESS).toBe(true);
    expect(loadConfig({ ...BASE, VERCEL: '1', SERVERLESS: 'false' }).SERVERLESS).toBe(false);
  });

  it('keeps evidence bodies under the 4.5 MB serverless request limit', () => {
    expect(loadConfig(BASE).MAX_EVIDENCE_BYTES).toBeLessThan(4.5 * 1000 * 1000);
  });

  it('reads DB_PREPARE as a boolean', () => {
    expect(loadConfig(BASE).DB_PREPARE).toBe(true);
    expect(loadConfig({ ...BASE, DB_PREPARE: 'false' }).DB_PREPARE).toBe(false);
  });
});

describe('GET /v1/internal/retention', () => {
  let ctx: TestContext;
  let off: TestContext;
  beforeAll(async () => {
    [ctx, off] = await Promise.all([
      createTestContext({ CRON_SECRET: SECRET }),
      createTestContext(),
    ]);
  });
  afterAll(() => Promise.all([ctx.close(), off.close()]));

  const run = (c: TestContext, token?: string) =>
    call(c.app, token, { method: 'GET', url: '/v1/internal/retention' });

  it('runs retention with the cron secret', async () => {
    const res = await run(ctx, SECRET);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionsDeleted: 0, objectsDeleted: 0, failures: 0 });
  });

  it('refuses a missing or wrong secret, and user tokens', async () => {
    expect((await run(ctx)).statusCode).toBe(401);
    expect((await run(ctx, `${SECRET}x`)).statusCode).toBe(401);
    expect((await run(ctx, ctx.orgA.adminToken)).statusCode).toBe(401);
  });

  it('does not exist when CRON_SECRET is unset', async () => {
    expect((await run(off, SECRET)).statusCode).toBe(404);
  });
});
