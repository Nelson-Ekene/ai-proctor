import {
  computeRisk,
  DEFAULT_POLICY,
  mergeViolations,
  openAnomaly,
  packageAnomaly,
  type Anomaly,
  type Policy,
} from '@proctor/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anomalies as anomaliesTable, sessions } from '../src/db/schema';
import { storedViolations } from '../src/ingest';
import type { SessionReport } from '../src/report';
import {
  anomaly,
  call,
  createTestContext,
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

const T0 = Date.parse('2026-10-01T09:00:00Z');
const MIN = 60_000;

async function report(s: StartedSession): Promise<SessionReport> {
  const res = await call(ctx.app, ctx.orgA.reviewerToken, {
    method: 'GET',
    url: `/v1/sessions/${s.sessionId}/report`,
  });
  expect(res.statusCode).toBe(200);
  return res.json<SessionReport>();
}

/**
 * PRD sample: browser 50, video 60, audio 25 at weights 40/40/20 = 49.0 Medium, built from real
 * anomalies (each in its own merge window) under DEFAULT_POLICY.
 */
function prdSample(): Anomaly[] {
  return [
    // browser: 3 x tab switch (medium 15) + copy/paste (low 5) = 50
    anomaly('tab_switch_or_blur', T0),
    anomaly('tab_switch_or_blur', T0 + 2 * MIN),
    anomaly('tab_switch_or_blur', T0 + 4 * MIN),
    anomaly('copy_paste', T0 + 5 * MIN),
    // video: 2 x phone (high 30) = 60
    anomaly('phone_detected', T0 + MIN, 1, [
      { id: `f-${String(T0)}`, kind: 'frame', ts: T0 + MIN },
    ]),
    anomaly('phone_detected', T0 + 3 * MIN),
    // audio: speech (medium 15 x 1) + speech (medium 15 x 2/3) = 25
    anomaly('speech_detected', T0 + 6 * MIN, 1),
    anomaly('speech_detected', T0 + 8 * MIN, 2 / 3),
  ];
}

describe('anomaly ingestion: merge and scoring', () => {
  it('scores the PRD sample at 49.0 Medium', async () => {
    const s = await startSession(ctx, ctx.orgA);
    for (const a of prdSample()) expect((await postAnomaly(ctx, s, a)).statusCode).toBe(201);
    const r = await report(s);
    expect(r.risk).toBe(49);
    expect(r.band).toBe('medium');
    expect(r.categories.map((c) => [c.category, c.score, c.contribution])).toEqual([
      ['browser', 50, 20],
      ['video', 60, 24],
      ['audio', 25, 5],
    ]);
    expect(r.reproducible).toBe(true);
  });

  it('merges anomalies of the same type within the merge window into one violation', async () => {
    const s = await startSession(ctx, ctx.orgA);
    const burst = [0, 10_000, 59_000].map((d) => anomaly('fullscreen_exit', T0 + d));
    const later = anomaly('fullscreen_exit', T0 + 61_000);
    for (const a of [...burst, later]) await postAnomaly(ctx, s, a);
    const r = await report(s);
    expect(r.violations.map((v) => [v.type, v.count])).toEqual([
      ['fullscreen_exit', 3],
      ['fullscreen_exit', 1],
    ]);
    expect(r.violations[0]?.evidence).toHaveLength(3);
    // count does not multiply points by default: 15 + 15 = 30 browser points
    expect(r.categories[0]?.rawPoints).toBe(30);
  });

  it('counts a retried anomaly exactly once', async () => {
    const s = await startSession(ctx, ctx.orgA);
    const a = anomaly('phone_detected', T0, 0.9);
    expect((await postAnomaly(ctx, s, a)).statusCode).toBe(201);
    const retry = await postAnomaly(ctx, s, a);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ ok: true, duplicate: true });
    const r = await report(s);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]?.count).toBe(1);
    expect(r.risk).toBe(10.8); // 0.4 x (30 x 0.9)
  });

  it('applies concurrent uploads for one session without losing any', async () => {
    const s = await startSession(ctx, ctx.orgA);
    const batch = Array.from({ length: 12 }, (_, i) => anomaly('no_face', T0 + i * 2 * MIN, 0.8));
    const results = await Promise.all(batch.map((a) => postAnomaly(ctx, s, a)));
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    const r = await report(s);
    expect(r.violations).toHaveLength(12);
    expect(r.categories[1]?.rawPoints).toBeCloseTo(12 * 15 * 0.8);
    expect(r.categories[1]?.score).toBe(100); // capped
    expect(r.reproducible).toBe(true);
  });

  it('never returns the score to the candidate device', async () => {
    const s = await startSession(ctx, ctx.orgA);
    const res = await postAnomaly(ctx, s, anomaly('phone_detected', T0));
    expect(res.json()).toEqual({ ok: true });
  });

  it('rejects anomalies without evidence or of unknown type', async () => {
    const s = await startSession(ctx, ctx.orgA);
    const noEvidence = { ...anomaly('copy_paste', T0), evidence: [] };
    const unknown = { ...anomaly('copy_paste', T0), type: 'cheating' };
    for (const body of [noEvidence, unknown]) {
      const res = await call(ctx.app, s.token, {
        method: 'POST',
        url: `/v1/sessions/${s.sessionId}/anomalies`,
        payload: body,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('accepts the exact package the extension builds (contract)', async () => {
    const s = await startSession(ctx, ctx.orgA);
    const log = [
      { type: 'visibility_hidden' as const, ts: T0 },
      { type: 'visibility_visible' as const, ts: T0 + 4_000 },
    ];
    const open = openAnomaly(
      { type: 'tab_switch_or_blur', ts: T0, confidence: 1 },
      'contract-anomaly',
      log,
      s.policySnapshot,
    );
    const pkg = packageAnomaly(open, log, [], 'contract-seq', s.policySnapshot);
    expect((await postAnomaly(ctx, s, pkg.anomaly)).statusCode).toBe(201);
    const evidence = await call(ctx.app, s.token, {
      method: 'PUT',
      url: `/v1/sessions/${s.sessionId}/evidence/contract-seq`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(pkg.eventSequence),
    });
    expect(evidence.statusCode).toBe(201);
  });
});

describe('reproducibility', () => {
  it('a report regenerates the identical score from stored violations + policy snapshot', async () => {
    const s = await startSession(ctx, ctx.orgA);
    for (const a of prdSample()) await postAnomaly(ctx, s, a);
    const [session] = await ctx.db.select().from(sessions).where(eq(sessions.id, s.sessionId));
    if (!session) throw new Error('missing session');

    // 1. From the stored violations + the stored policy snapshot (no server code involved).
    const fromViolations = computeRisk(
      await storedViolations(ctx.db, s.sessionId),
      session.policySnapshot,
    );
    // 2. From the raw stored anomalies, merged again.
    const raw = await ctx.db
      .select()
      .from(anomaliesTable)
      .where(eq(anomaliesTable.sessionId, s.sessionId));
    const remerged = computeRisk(
      mergeViolations(
        raw.map((a) => ({
          id: a.id,
          type: a.type as Anomaly['type'],
          ts: a.ts,
          confidence: a.confidence,
          evidence: a.evidence,
        })),
        session.policySnapshot,
      ),
      session.policySnapshot,
    );
    const r = await report(s);
    for (const result of [fromViolations, remerged]) {
      expect(result.risk).toBe(session.risk);
      expect(result.band).toBe(session.band);
      expect(result.categories).toEqual(r.categories);
    }
    expect(r.risk).toBe(session.risk);
    expect(r.policySnapshot).toEqual(session.policySnapshot);

    // Repeated reports are identical apart from their generation time.
    const again = await report(s);
    expect({ ...again, generatedAt: '' }).toEqual({ ...r, generatedAt: '' });
  });

  it('a later policy change does not change the score of an existing session', async () => {
    const s = await startSession(ctx, ctx.orgA);
    for (const a of prdSample()) await postAnomaly(ctx, s, a);
    const before = await report(s);

    const stricter: Policy = {
      ...DEFAULT_POLICY,
      weights: { browser: 0.2, video: 0.2, audio: 0.6 },
      severityPoints: { low: 10, medium: 30, high: 60 },
    };
    const put = await call(ctx.app, ctx.orgA.adminToken, {
      method: 'PUT',
      url: '/v1/policies',
      payload: { policy: stricter },
    });
    expect(put.statusCode).toBe(200);
    await postAnomaly(ctx, s, anomaly('copy_paste', T0 + 30 * MIN));

    const after = await report(s);
    expect(after.policySnapshot).toEqual(before.policySnapshot);
    expect(after.risk).toBe(
      computeRisk(await storedViolations(ctx.db, s.sessionId), DEFAULT_POLICY).risk,
    );

    // New sessions get the new policy.
    const next = await startSession(ctx, ctx.orgA);
    expect(next.policySnapshot.weights).toEqual(stricter.weights);
  });

  it('every violation links to evidence', async () => {
    const s = await startSession(ctx, ctx.orgA);
    for (const a of prdSample()) await postAnomaly(ctx, s, a);
    const r = await report(s);
    expect(r.violations.length).toBeGreaterThan(0);
    for (const v of r.violations) expect(v.evidence.length).toBeGreaterThan(0);
  });
});
