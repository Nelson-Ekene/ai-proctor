import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anomalies, auditLog, consents, evidence, sessions, violations } from '../src/db/schema';
import {
  anomaly,
  call,
  createTestContext,
  JPEG,
  postAnomaly,
  putEvidence,
  startSession,
  type TestContext,
} from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

async function sessionWithFrame() {
  const s = await startSession(ctx, ctx.orgA);
  const consent = await call(ctx.app, s.token, {
    method: 'POST',
    url: `/v1/sessions/${s.sessionId}/consents`,
    payload: { decision: 'accepted', noticeVersion: 'consent-notice-v1', ts: 1 },
  });
  expect(consent.statusCode).toBe(201);
  const frameId = `frame-${String(Math.random())}`;
  const now = ctx.clock.now.getTime();
  await postAnomaly(
    ctx,
    s,
    anomaly('phone_detected', now, 1, [{ id: frameId, kind: 'frame', ts: now }]),
  );
  expect((await putEvidence(ctx, s, frameId, 'image/jpeg', JPEG)).statusCode).toBe(201);
  const [row] = await ctx.db.select().from(evidence).where(eq(evidence.id, frameId));
  return { s, frameId, key: row?.storageKey ?? '' };
}

const remove = (token: string, id: string) =>
  call(ctx.app, token, { method: 'DELETE', url: `/v1/sessions/${id}` });

async function exists(id: string): Promise<boolean> {
  return (await ctx.db.select().from(sessions).where(eq(sessions.id, id))).length > 0;
}

describe('DELETE /v1/sessions/:id', () => {
  it('lets an admin delete a session with all its data and evidence objects, audit-logged', async () => {
    const { s, frameId, key } = await sessionWithFrame();
    expect(await ctx.storage.encryption(key)).toBe('AES256');

    const res = await remove(ctx.orgA.adminToken, s.sessionId);
    expect(res.statusCode).toBe(204);

    expect(await exists(s.sessionId)).toBe(false);
    for (const table of [anomalies, violations, evidence, consents]) {
      const rows = await ctx.db.select().from(table).where(eq(table.sessionId, s.sessionId));
      expect(rows).toHaveLength(0);
    }
    await expect(ctx.storage.encryption(key)).rejects.toThrow();
    const report = await call(ctx.app, ctx.orgA.adminToken, {
      method: 'GET',
      url: `/v1/sessions/${s.sessionId}/report`,
    });
    expect(report.statusCode).toBe(404);

    const [entry] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, s.sessionId), eq(auditLog.action, 'session.delete')));
    expect(entry).toMatchObject({
      actorType: 'user',
      organisationId: ctx.orgA.id,
      details: { evidenceObjects: 1 },
    });

    // The candidate's device can no longer upload into the deleted session.
    expect((await putEvidence(ctx, s, frameId, 'image/jpeg', JPEG)).statusCode).toBe(401);
  });

  it('is refused for reviewers and for other organisations, leaving the session intact', async () => {
    const { s } = await sessionWithFrame();
    expect((await remove(ctx.orgA.reviewerToken, s.sessionId)).statusCode).toBe(403);
    expect((await remove(ctx.orgB.adminToken, s.sessionId)).statusCode).toBe(404);
    expect((await remove(ctx.orgA.adminToken, 'not-a-uuid')).statusCode).toBe(400);
    expect(await exists(s.sessionId)).toBe(true);
  });

  it('keeps the session when its evidence objects cannot be deleted', async () => {
    const { s, key } = await sessionWithFrame();
    const original = ctx.storage.remove.bind(ctx.storage);
    ctx.storage.remove = () => Promise.reject(new Error('storage unavailable'));
    try {
      expect((await remove(ctx.orgA.adminToken, s.sessionId)).statusCode).toBe(500);
    } finally {
      ctx.storage.remove = original;
    }
    expect(await exists(s.sessionId)).toBe(true);
    expect(await ctx.storage.encryption(key)).toBe('AES256');
    expect((await remove(ctx.orgA.adminToken, s.sessionId)).statusCode).toBe(204);
  });
});
