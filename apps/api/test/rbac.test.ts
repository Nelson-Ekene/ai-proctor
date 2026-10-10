import { DEFAULT_POLICY } from '@proctor/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createTestContext, startSession, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

describe('RBAC: admin-only routes', () => {
  const adminOnly = [
    { method: 'PUT', url: '/v1/policies', payload: { policy: DEFAULT_POLICY } },
    { method: 'GET', url: '/v1/audit' },
    { method: 'POST', url: '/v1/exams', payload: { name: 'Maths' } },
    { method: 'GET', url: '/v1/api-keys' },
    { method: 'POST', url: '/v1/api-keys', payload: { label: 'x' } },
    { method: 'GET', url: '/v1/users' },
    {
      method: 'POST',
      url: '/v1/users',
      payload: { email: 'new@a.test', password: 'long enough password', role: 'reviewer' },
    },
  ] as const;

  it.each(adminOnly)('$method $url: reviewer 403, admin allowed', async (route) => {
    const asReviewer = await call(ctx.app, ctx.orgA.reviewerToken, route);
    expect(asReviewer.statusCode).toBe(403);
    const asAdmin = await call(ctx.app, ctx.orgA.adminToken, route);
    expect(asAdmin.statusCode).toBeLessThan(300);
  });

  it.each(adminOnly)('$method $url: anonymous 401', async (route) => {
    expect((await call(ctx.app, undefined, route)).statusCode).toBe(401);
  });
});

describe('RBAC: reviewer routes', () => {
  it('reviewers can list sessions, read reports and policies', async () => {
    const s = await startSession(ctx, ctx.orgA);
    for (const url of [
      '/v1/sessions',
      `/v1/sessions/${s.sessionId}/report`,
      '/v1/policies',
      '/v1/exams',
    ]) {
      const res = await call(ctx.app, ctx.orgA.reviewerToken, { method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
    }
  });
});

describe('organisation isolation', () => {
  it("users never see another organisation's sessions, reports or evidence", async () => {
    const s = await startSession(ctx, ctx.orgB);
    for (const url of [
      `/v1/sessions/${s.sessionId}/report`,
      `/v1/sessions/${s.sessionId}/report.json`,
      `/v1/sessions/${s.sessionId}/report.pdf`,
      `/v1/sessions/${s.sessionId}/evidence/any/url`,
    ]) {
      const res = await call(ctx.app, ctx.orgA.adminToken, { method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
    }
    const list = await call(ctx.app, ctx.orgA.adminToken, { method: 'GET', url: '/v1/sessions' });
    const ids = list.json<{ sessions: { id: string }[] }>().sessions.map((x) => x.id);
    expect(ids).not.toContain(s.sessionId);
  });

  it("an API key cannot start a session for another organisation's exam", async () => {
    const exam = await call(ctx.app, ctx.orgB.adminToken, {
      method: 'POST',
      url: '/v1/exams',
      payload: { name: 'B exam' },
    });
    const res = await call(ctx.app, ctx.orgA.apiKey, {
      method: 'POST',
      url: '/v1/sessions',
      payload: { candidateRef: 'c', examId: exam.json<{ id: string }>().id },
    });
    expect(res.statusCode).toBe(404);
  });

  it("admins cannot change another organisation's exam policy", async () => {
    const exam = await call(ctx.app, ctx.orgB.adminToken, {
      method: 'POST',
      url: '/v1/exams',
      payload: { name: 'B exam 2' },
    });
    const res = await call(ctx.app, ctx.orgA.adminToken, {
      method: 'PUT',
      url: '/v1/policies',
      payload: { examId: exam.json<{ id: string }>().id, policy: DEFAULT_POLICY },
    });
    expect(res.statusCode).toBe(404);
  });
});
