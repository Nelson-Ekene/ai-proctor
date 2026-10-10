import { DEFAULT_POLICY } from '@proctor/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  anomalies,
  auditLog,
  evidence,
  sessions,
  userSessions,
  violations,
} from '../src/db/schema';
import { runRetention } from '../src/retention';
import type { EvidenceStorage } from '../src/storage';
import {
  anomaly,
  call,
  createTestContext,
  JPEG,
  login,
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

const DAY = 24 * 60 * 60 * 1000;

async function sessionWithFrame() {
  const s = await startSession(ctx, ctx.orgA);
  const frameId = `frame-${String(Math.random())}`;
  const a = anomaly('phone_detected', ctx.clock.now.getTime(), 1, [
    { id: frameId, kind: 'frame', ts: ctx.clock.now.getTime() },
  ]);
  await postAnomaly(ctx, s, a);
  expect((await putEvidence(ctx, s, frameId, 'image/jpeg', JPEG)).statusCode).toBe(201);
  const [row] = await ctx.db.select().from(evidence).where(eq(evidence.id, frameId));
  return { s, key: row?.storageKey ?? '' };
}

async function exists(sessionId: string): Promise<boolean> {
  return (await ctx.db.select().from(sessions).where(eq(sessions.id, sessionId))).length > 0;
}

describe('retention job', () => {
  it("deletes sessions, their data and their objects after the snapshot's retentionDays", async () => {
    const old = await sessionWithFrame();
    const end = await call(ctx.app, old.s.token, {
      method: 'POST',
      url: `/v1/sessions/${old.s.sessionId}/end`,
      payload: { ts: 1 },
    });
    expect(end.statusCode).toBe(204);

    // Not yet: exactly retentionDays have not passed.
    const early = await runRetention(
      ctx.db,
      ctx.storage,
      new Date(ctx.clock.now.getTime() + 29 * DAY),
    );
    expect(early.sessionsDeleted).toBe(0);
    expect(await ctx.storage.encryption(old.key)).toBe('AES256');

    const now = new Date(ctx.clock.now.getTime() + DEFAULT_POLICY.retentionDays * DAY + 1);
    const result = await runRetention(ctx.db, ctx.storage, now);
    expect(result).toMatchObject({ sessionsDeleted: 1, objectsDeleted: 1, failures: 0 });

    expect(await exists(old.s.sessionId)).toBe(false);
    for (const table of [anomalies, violations, evidence]) {
      const rows = await ctx.db.select().from(table).where(eq(table.sessionId, old.s.sessionId));
      expect(rows).toHaveLength(0);
    }
    await expect(ctx.storage.encryption(old.key)).rejects.toThrow();
    // Expired dashboard login tokens are purged in the same run.
    expect(await ctx.db.select().from(userSessions)).toHaveLength(0);

    // Audit-logged, and the audit trail itself is kept.
    const [entry] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, old.s.sessionId), eq(auditLog.action, 'retention.delete')));
    expect(entry).toMatchObject({
      actorType: 'system',
      action: 'retention.delete',
      organisationId: ctx.orgA.id,
      details: { evidenceObjects: 1 },
    });
  });

  it("uses each session's own policy snapshot (per-exam retention)", async () => {
    // The previous run also purged expired login tokens, so log in again.
    const admin = await login(ctx.app, 'admin@a.test');
    const put = await call(ctx.app, admin, {
      method: 'PUT',
      url: '/v1/policies',
      payload: { policy: { ...DEFAULT_POLICY, retentionDays: 3 } },
    });
    expect(put.statusCode).toBe(200);
    const short = await startSession(ctx, ctx.orgA);
    await call(ctx.app, admin, {
      method: 'PUT',
      url: '/v1/policies',
      payload: { policy: DEFAULT_POLICY },
    });
    const long = await startSession(ctx, ctx.orgA);

    // Unended sessions count from their start.
    const result = await runRetention(
      ctx.db,
      ctx.storage,
      new Date(ctx.clock.now.getTime() + 4 * DAY),
    );
    expect(result.sessionsDeleted).toBe(1);
    expect(await exists(short.sessionId)).toBe(false);
    expect(await exists(long.sessionId)).toBe(true);
  });

  it('keeps a session whose objects could not be deleted, and retries next run', async () => {
    const { s, key } = await sessionWithFrame();
    const failing: EvidenceStorage = {
      ...ctx.storage,
      remove: () => Promise.reject(new Error('storage unavailable')),
    };
    const later = new Date(ctx.clock.now.getTime() + 31 * DAY);
    const failed = await runRetention(ctx.db, failing, later);
    expect(failed.failures).toBeGreaterThanOrEqual(1);
    expect(await exists(s.sessionId)).toBe(true);
    expect(await ctx.storage.encryption(key)).toBe('AES256');

    const retried = await runRetention(ctx.db, ctx.storage, later);
    expect(retried.failures).toBe(0);
    expect(await exists(s.sessionId)).toBe(false);
  });
});
