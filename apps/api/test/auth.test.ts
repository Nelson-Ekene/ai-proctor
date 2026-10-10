import { SessionInfoSchema } from '@proctor/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createTestContext, login, startSession, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

describe('integrator API keys', () => {
  it('starting a session requires a valid API key', async () => {
    const payload = { candidateRef: 'c' };
    for (const token of [undefined, 'pak_wrong', ctx.orgA.adminToken]) {
      const res = await call(ctx.app, token, { method: 'POST', url: '/v1/sessions', payload });
      expect(res.statusCode).toBe(401);
    }
    const ok = await call(ctx.app, ctx.orgA.apiKey, {
      method: 'POST',
      url: '/v1/sessions',
      payload,
    });
    expect(ok.statusCode).toBe(201);
  });

  it('a revoked key stops working', async () => {
    const created = await call(ctx.app, ctx.orgA.adminToken, {
      method: 'POST',
      url: '/v1/api-keys',
      payload: { label: 'temp' },
    });
    expect(created.statusCode).toBe(201);
    const { id, key } = created.json<{ id: string; key: string }>();
    const start = () =>
      call(ctx.app, key, { method: 'POST', url: '/v1/sessions', payload: { candidateRef: 'c' } });
    expect((await start()).statusCode).toBe(201);
    const revoke = await call(ctx.app, ctx.orgA.adminToken, {
      method: 'DELETE',
      url: `/v1/api-keys/${id}`,
    });
    expect(revoke.statusCode).toBe(204);
    expect((await start()).statusCode).toBe(401);
  });

  it('API keys are stored only as hashes', async () => {
    const list = await call(ctx.app, ctx.orgA.adminToken, { method: 'GET', url: '/v1/api-keys' });
    expect(JSON.stringify(list.json())).not.toContain('pak_');
  });
});

describe('session tokens (extension)', () => {
  it('resolves to its own session and policy snapshot (extension contract)', async () => {
    const s = await startSession(ctx, ctx.orgA);
    const res = await call(ctx.app, s.token, { method: 'GET', url: '/v1/sessions/current' });
    expect(res.statusCode).toBe(200);
    const info = SessionInfoSchema.parse(res.json());
    expect(info).toEqual({ sessionId: s.sessionId, policySnapshot: s.policySnapshot });
  });

  it("never reaches another session's data", async () => {
    const mine = await startSession(ctx, ctx.orgA);
    const other = await startSession(ctx, ctx.orgA);
    const res = await call(ctx.app, mine.token, {
      method: 'POST',
      url: `/v1/sessions/${other.sessionId}/end`,
      payload: { ts: 1 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('expires after SESSION_TOKEN_TTL_MS', async () => {
    const s = await startSession(ctx, ctx.orgA);
    ctx.clock.advance(12 * 60 * 60 * 1000 + 1);
    const res = await call(ctx.app, s.token, { method: 'GET', url: '/v1/sessions/current' });
    ctx.clock.advance(-(12 * 60 * 60 * 1000 + 1));
    expect(res.statusCode).toBe(401);
  });

  it('cannot be used on dashboard routes', async () => {
    const s = await startSession(ctx, ctx.orgA);
    const res = await call(ctx.app, s.token, { method: 'GET', url: '/v1/sessions' });
    expect(res.statusCode).toBe(401);
  });
});

describe('user login', () => {
  it('rejects a wrong password and an unknown e-mail alike', async () => {
    for (const email of ['admin@a.test', 'nobody@a.test']) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email, password: 'wrong password' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorised' });
    }
  });

  it('issues a token that expires and can be revoked by logout', async () => {
    const token = await login(ctx.app, 'reviewer@a.test');
    const me = await call(ctx.app, token, { method: 'GET', url: '/v1/me' });
    expect(me.json()).toMatchObject({ email: 'reviewer@a.test', role: 'reviewer' });

    const logout = await call(ctx.app, token, { method: 'POST', url: '/v1/auth/logout' });
    expect(logout.statusCode).toBe(204);
    expect((await call(ctx.app, token, { method: 'GET', url: '/v1/me' })).statusCode).toBe(401);

    const second = await login(ctx.app, 'reviewer@a.test');
    ctx.clock.advance(8 * 60 * 60 * 1000 + 1);
    const expired = await call(ctx.app, second, { method: 'GET', url: '/v1/me' });
    ctx.clock.advance(-(8 * 60 * 60 * 1000 + 1));
    expect(expired.statusCode).toBe(401);
  });

  it('login tokens cannot be used as session tokens', async () => {
    expect(
      (await call(ctx.app, ctx.orgA.reviewerToken, { method: 'GET', url: '/v1/me' })).statusCode,
    ).toBe(200);
    const res = await call(ctx.app, ctx.orgA.reviewerToken, {
      method: 'GET',
      url: '/v1/sessions/current',
    });
    expect(res.statusCode).toBe(401);
  });
});
