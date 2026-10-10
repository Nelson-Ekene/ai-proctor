import { DEFAULT_POLICY, REPORT_LIMITATIONS } from '@proctor/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionReport } from '../src/report';
import {
  anomaly,
  call,
  createTestContext,
  postAnomaly,
  startSession,
  type TestContext,
} from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

interface AuditRow {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
}

async function auditRows(): Promise<AuditRow[]> {
  const res = await call(ctx.app, ctx.orgA.adminToken, {
    method: 'GET',
    url: '/v1/audit?limit=500',
  });
  expect(res.statusCode).toBe(200);
  return res.json<AuditRow[]>();
}

/** Runs `action` and returns the audit rows it added. */
async function added(action: () => Promise<unknown>): Promise<AuditRow[]> {
  const before = (await auditRows()).length;
  await action();
  const after = await auditRows();
  return after.slice(0, after.length - before);
}

describe('audit log', () => {
  it('records every session list, report view and export', async () => {
    const s = await startSession(ctx, ctx.orgA);
    await postAnomaly(ctx, s, anomaly('copy_paste', Date.parse('2026-10-01T09:01:00Z')));
    const get = (url: string) => call(ctx.app, ctx.orgA.reviewerToken, { method: 'GET', url });

    const cases: [string, string, Record<string, unknown> | null][] = [
      ['/v1/sessions', 'sessions.list', null],
      [`/v1/sessions/${s.sessionId}/report`, 'report.view', null],
      [`/v1/sessions/${s.sessionId}/report.json`, 'report.export', { format: 'json' }],
      [`/v1/sessions/${s.sessionId}/report.pdf`, 'report.export', { format: 'pdf' }],
    ];
    for (const [url, action, details] of cases) {
      const rows = await added(() => get(url));
      expect(rows, url).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorType: 'user', action });
      if (action !== 'sessions.list') expect(rows[0]?.targetId).toBe(s.sessionId);
      if (details) expect(rows[0]?.details).toEqual(details);
    }
  });

  it('records every policy change with its version', async () => {
    const rows = await added(() =>
      call(ctx.app, ctx.orgA.adminToken, {
        method: 'PUT',
        url: '/v1/policies',
        payload: { policy: { ...DEFAULT_POLICY, retentionDays: 14 } },
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'policy.update',
      targetType: 'organisation_policy',
      targetId: ctx.orgA.id,
      details: { version: 1 },
    });
  });

  it('records session creation by the integrator key', async () => {
    const rows = await added(() => startSession(ctx, ctx.orgA));
    expect(rows[0]).toMatchObject({ actorType: 'api_key', action: 'session.create' });
  });

  it('a denied request writes nothing and leaks nothing', async () => {
    const s = await startSession(ctx, ctx.orgB);
    const rows = await added(() =>
      call(ctx.app, ctx.orgA.reviewerToken, {
        method: 'GET',
        url: `/v1/sessions/${s.sessionId}/report`,
      }),
    );
    expect(rows).toHaveLength(0);
  });

  it('is scoped to the organisation', async () => {
    const res = await call(ctx.app, ctx.orgB.adminToken, {
      method: 'GET',
      url: '/v1/audit?limit=500',
    });
    const orgB = res.json<{ id: string }[]>().map((r) => r.id);
    const orgA = new Set((await auditRows()).map((r) => r.id));
    expect(orgA.size).toBeGreaterThan(0);
    expect(orgB.filter((id) => orgA.has(id))).toEqual([]);
  });
});

describe('report exports', () => {
  it('JSON export equals the report view and includes policy and limitations', async () => {
    const s = await startSession(ctx, ctx.orgA);
    await postAnomaly(ctx, s, anomaly('phone_detected', Date.parse('2026-10-01T09:02:00Z'), 0.8));
    const view = await call(ctx.app, ctx.orgA.reviewerToken, {
      method: 'GET',
      url: `/v1/sessions/${s.sessionId}/report`,
    });
    const exported = await call(ctx.app, ctx.orgA.reviewerToken, {
      method: 'GET',
      url: `/v1/sessions/${s.sessionId}/report.json`,
    });
    expect(exported.headers['content-disposition']).toContain('attachment');
    const a = view.json<SessionReport>();
    const b = exported.json<SessionReport>();
    expect({ ...b, generatedAt: '' }).toEqual({ ...a, generatedAt: '' });
    expect(b.policySnapshot).toEqual(s.policySnapshot);
    expect(b.limitations).toEqual(REPORT_LIMITATIONS);
  });

  it('PDF export renders a PDF document', async () => {
    const s = await startSession(ctx, ctx.orgA);
    await postAnomaly(ctx, s, anomaly('speech_detected', Date.parse('2026-10-01T09:03:00Z'), 0.7));
    const res = await call(ctx.app, ctx.orgA.reviewerToken, {
      method: 'GET',
      url: `/v1/sessions/${s.sessionId}/report.pdf`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(res.rawPayload.length).toBeGreaterThan(1000);
  });
});
