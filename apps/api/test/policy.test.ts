import { DEFAULT_POLICY, type Policy } from '@proctor/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createTestContext, startSession, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

interface PolicyView {
  examId: string | null;
  effective: { policy: Policy; version: number | null; source: string };
  versions: { version: number; policy: Policy | null }[];
}

const withRetention = (days: number): Policy => ({ ...DEFAULT_POLICY, retentionDays: days });

async function getPolicy(token: string, examId?: string): Promise<PolicyView> {
  const res = await call(ctx.app, token, {
    method: 'GET',
    url: `/v1/policies${examId ? `?examId=${examId}` : ''}`,
  });
  expect(res.statusCode).toBe(200);
  return res.json<PolicyView>();
}

async function putPolicy(policy: unknown, examId?: string) {
  return call(ctx.app, ctx.orgA.adminToken, {
    method: 'PUT',
    url: '/v1/policies',
    payload: { policy, ...(examId ? { examId } : {}) },
  });
}

async function createExam(name: string): Promise<string> {
  const res = await call(ctx.app, ctx.orgA.adminToken, {
    method: 'POST',
    url: '/v1/exams',
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

describe('policy versioning', () => {
  it('falls back to DEFAULT_POLICY before any version exists', async () => {
    const view = await getPolicy(ctx.orgA.reviewerToken);
    expect(view.effective).toMatchObject({ source: 'default', version: null });
    expect(view.effective.policy).toEqual(DEFAULT_POLICY);
  });

  it('appends versions; older versions stay readable', async () => {
    expect((await putPolicy(withRetention(10))).json()).toMatchObject({ version: 1 });
    expect((await putPolicy(withRetention(20))).json()).toMatchObject({ version: 2 });
    const view = await getPolicy(ctx.orgA.reviewerToken);
    expect(view.effective).toMatchObject({ source: 'organisation', version: 2 });
    expect(view.versions.map((v) => [v.version, v.policy?.retentionDays])).toEqual([
      [2, 20],
      [1, 10],
    ]);
  });

  it('rejects invalid policies with 400 (weights must sum to 1)', async () => {
    const bad = { ...DEFAULT_POLICY, weights: { browser: 0.5, video: 0.5, audio: 0.5 } };
    const res = await putPolicy(bad);
    expect(res.statusCode).toBe(400);
    expect((await getPolicy(ctx.orgA.reviewerToken)).effective.version).toBe(2);
  });

  it('per-exam override beats the organisation default; removing it inherits again', async () => {
    const examId = await createExam('Physics');
    expect((await getPolicy(ctx.orgA.reviewerToken, examId)).effective.source).toBe('organisation');

    expect((await putPolicy(withRetention(7), examId)).statusCode).toBe(200);
    const overridden = await getPolicy(ctx.orgA.reviewerToken, examId);
    expect(overridden.effective).toMatchObject({ source: 'exam', version: 1 });
    expect(overridden.effective.policy.retentionDays).toBe(7);

    // Sessions snapshot the policy in force when they start.
    const examSession = await startSession(ctx, ctx.orgA, { examId });
    const plainSession = await startSession(ctx, ctx.orgA);
    expect(examSession.policySnapshot.retentionDays).toBe(7);
    expect(plainSession.policySnapshot.retentionDays).toBe(20);

    const removed = await call(ctx.app, ctx.orgA.adminToken, {
      method: 'DELETE',
      url: `/v1/policies/exams/${examId}`,
    });
    expect(removed.json()).toMatchObject({ version: 2 });
    const inherited = await getPolicy(ctx.orgA.reviewerToken, examId);
    expect(inherited.effective).toMatchObject({ source: 'organisation', version: 2 });
    expect(inherited.versions.map((v) => v.policy?.retentionDays ?? null)).toEqual([null, 7]);

    const again = await call(ctx.app, ctx.orgA.adminToken, {
      method: 'DELETE',
      url: `/v1/policies/exams/${examId}`,
    });
    expect(again.statusCode).toBe(404);
  });

  it('policies are per organisation', async () => {
    const view = await getPolicy(ctx.orgB.reviewerToken);
    expect(view.effective.source).toBe('default');
  });
});
