import { DEFAULT_POLICY } from '@proctor/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organisations } from '../src/db/schema';
import type { Metrics } from '../src/metrics';
import { runRetention } from '../src/retention';
import {
  anomaly,
  call,
  createTestContext,
  login,
  postAnomaly,
  startSession,
  type StartedSession,
  type TestContext,
} from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

const DAY = 24 * 60 * 60 * 1000;
const READY = { face: 'ready', mic: 'ready', performance: 'ready' } as const;

function consent(s: StartedSession, noticeVersion = 'consent-notice-v1', decision = 'accepted') {
  return call(ctx.app, s.token, {
    method: 'POST',
    url: `/v1/sessions/${s.sessionId}/consents`,
    payload: { decision, noticeVersion, ts: 1 },
  });
}

function setupCheck(s: StartedSession, result: Record<string, string> = READY) {
  return call(ctx.app, s.token, {
    method: 'POST',
    url: `/v1/sessions/${s.sessionId}/setup-check`,
    payload: { result, ts: 2 },
  });
}

async function setRegion(orgId: string, region: 'eu' | 'uk' | 'us' | 'other') {
  await ctx.db.update(organisations).set({ region }).where(eq(organisations.id, orgId));
}

describe('setup-check record', () => {
  it('stores the first outcome once and rejects anything else', async () => {
    const s = await startSession(ctx, ctx.orgA);
    expect((await setupCheck(s)).statusCode).toBe(201);
    const again = await setupCheck(s, { ...READY, face: 'needs_attention' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ ok: true, duplicate: true });
    expect((await setupCheck(s, { ...READY, face: 'great' })).statusCode).toBe(400);
  });
});

describe('region rules', () => {
  it('accepts only consent notices valid in the region (non-retryable 422)', async () => {
    const s = await startSession(ctx, ctx.orgA);
    expect((await consent(s, 'some-other-notice')).statusCode).toBe(422);
    expect((await consent(s)).statusCode).toBe(201);
  });

  it('accepts the face-matching opt-in notice (phase 11)', async () => {
    const s = await startSession(ctx, ctx.orgA);
    expect((await consent(s, 'consent-notice-v1+face-match-v1')).statusCode).toBe(201);
  });

  it('caps policy retention by region', async () => {
    const put = (retentionDays: number) =>
      call(ctx.app, ctx.orgB.adminToken, {
        method: 'PUT',
        url: '/v1/policies',
        payload: { policy: { ...DEFAULT_POLICY, retentionDays } },
      });
    const refused = await put(31);
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: string }>().error).toContain('at most 30 days');
    await setRegion(ctx.orgB.id, 'us');
    expect((await put(90)).statusCode).toBe(200);
    expect((await put(91)).statusCode).toBe(400);

    const org = await call(ctx.app, ctx.orgB.reviewerToken, {
      method: 'GET',
      url: '/v1/organisation',
    });
    expect(org.json()).toMatchObject({ region: 'us', regionConfig: { maxRetentionDays: 90 } });
  });

  it('retention never keeps data longer than the region allows', async () => {
    // orgB's policy keeps 90 days (us); the organisation then moves to the EU (30 days).
    const s = await startSession(ctx, ctx.orgB);
    expect(s.policySnapshot.retentionDays).toBe(90);
    await setRegion(ctx.orgB.id, 'eu');
    const result = await runRetention(
      ctx.db,
      ctx.storage,
      new Date(ctx.clock.now.getTime() + 31 * DAY),
    );
    expect(result.sessionsDeleted).toBeGreaterThanOrEqual(1);
    const list = await call(ctx.app, await login(ctx.app, 'admin@b.test'), {
      method: 'GET',
      url: '/v1/sessions',
    });
    expect(list.json<{ sessions: { id: string }[] }>().sessions.map((x) => x.id)).not.toContain(
      s.sessionId,
    );
  });
});

describe('metrics', () => {
  it('reports evidence linkage, setup completion and reviewer time; admins only', async () => {
    const since = new Date(ctx.clock.now.getTime() - 1000).toISOString();
    const a = await startSession(ctx, ctx.orgA);
    const b = await startSession(ctx, ctx.orgA);
    await consent(a);
    await consent(b);
    await setupCheck(a);
    await postAnomaly(ctx, a, anomaly('copy_paste', Date.parse('2026-10-01T09:05:00Z')));
    await postAnomaly(ctx, a, anomaly('phone_detected', Date.parse('2026-10-01T09:07:00Z'), 0.9));

    // Fresh logins: the retention run above purged tokens that had expired by then.
    const reviewer = await login(ctx.app, 'reviewer@a.test');
    const admin = await login(ctx.app, 'admin@a.test');
    for (const ms of [30_000, 15_000]) {
      const res = await call(ctx.app, reviewer, {
        method: 'POST',
        url: `/v1/sessions/${a.sessionId}/review-time`,
        payload: { ms },
      });
      expect(res.statusCode).toBe(204);
    }
    await call(ctx.app, reviewer, {
      method: 'POST',
      url: `/v1/sessions/${b.sessionId}/review-time`,
      payload: { ms: 60_000 },
    });

    expect((await call(ctx.app, reviewer, { method: 'GET', url: '/v1/metrics' })).statusCode).toBe(
      403,
    );
    const res = await call(ctx.app, admin, {
      method: 'GET',
      url: `/v1/metrics?since=${encodeURIComponent(since)}`,
    });
    expect(res.statusCode).toBe(200);
    const m = res.json<Metrics>();
    expect(m.sessions).toBe(2);
    expect(m.violations).toEqual({ total: 2, withEvidence: 2, evidenceLinkedRate: 1 });
    expect(m.evidence).toMatchObject({ referenced: 2, uploaded: 0, uploadedRate: 0 });
    expect(m.setupCheck).toEqual({ consented: 2, completed: 1, completionRate: 0.5, allReady: 1 });
    expect(m.reviewerTime).toEqual({
      reviewedSessions: 2,
      medianMs: 45_000,
      p90Ms: 60_000,
      meanMs: 52_500,
    });
  });

  it('review time is scoped to the organisation and bounded', async () => {
    const reviewer = await login(ctx.app, 'reviewer@a.test');
    const other = await startSession(ctx, ctx.orgB);
    const cross = await call(ctx.app, reviewer, {
      method: 'POST',
      url: `/v1/sessions/${other.sessionId}/review-time`,
      payload: { ms: 1000 },
    });
    expect(cross.statusCode).toBe(404);
    const mine = await startSession(ctx, ctx.orgA);
    const tooLong = await call(ctx.app, reviewer, {
      method: 'POST',
      url: `/v1/sessions/${mine.sessionId}/review-time`,
      payload: { ms: 5 * 60 * 60 * 1000 },
    });
    expect(tooLong.statusCode).toBe(400);
  });
});

describe('hardening', () => {
  it('pauses sign-in after repeated failures, then allows it again', async () => {
    const attempt = (password: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'reviewer@b.test', password },
      });
    for (let i = 0; i < 10; i++) expect((await attempt('wrong')).statusCode).toBe(401);
    const blocked = await attempt('correct horse battery staple');
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    // Another account is unaffected.
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email: 'admin@b.test', password: 'correct horse battery staple' },
        })
      ).statusCode,
    ).toBe(200);

    ctx.clock.advance(15 * 60 * 1000 + 1);
    const later = await attempt('correct horse battery staple');
    ctx.clock.advance(-(15 * 60 * 1000 + 1));
    expect(later.statusCode).toBe(200);
  });

  it('sends security headers on every response', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    });
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });
});
