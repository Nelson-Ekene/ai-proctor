import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evidence } from '../src/db/schema';
import {
  anomaly,
  call,
  createTestContext,
  JPEG,
  postAnomaly,
  putEvidence,
  startSession,
  WAV,
  type StartedSession,
  type TestContext,
} from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

const T0 = Date.parse('2026-10-01T09:00:00Z');

async function sessionWithEvidence(): Promise<{
  s: StartedSession;
  frameId: string;
  clipId: string;
  seqId: string;
}> {
  const s = await startSession(ctx, ctx.orgA);
  const frameId = `frame-${String(Math.random())}`;
  const clipId = `clip-${String(Math.random())}`;
  const a = anomaly('phone_detected', T0, 0.9, [
    { id: frameId, kind: 'frame', ts: T0 },
    { id: clipId, kind: 'audio', ts: T0 },
  ]);
  expect((await postAnomaly(ctx, s, a)).statusCode).toBe(201);
  return { s, frameId, clipId, seqId: a.evidence[0]?.id ?? '' };
}

async function storedRow(sessionId: string, id: string) {
  const rows = await ctx.db.select().from(evidence).where(eq(evidence.sessionId, sessionId));
  return rows.find((r) => r.id === id);
}

describe('evidence upload', () => {
  it('stores frames, clips and event sequences encrypted at rest under unguessable keys', async () => {
    const { s, frameId, clipId, seqId } = await sessionWithEvidence();
    const seq = JSON.stringify({
      from: T0 - 30_000,
      to: T0 + 15_000,
      events: [{ type: 'copy', ts: T0 }],
    });
    expect((await putEvidence(ctx, s, frameId, 'image/jpeg', JPEG)).statusCode).toBe(201);
    expect((await putEvidence(ctx, s, clipId, 'audio/wav', WAV)).statusCode).toBe(201);
    expect((await putEvidence(ctx, s, seqId, 'application/json', seq)).statusCode).toBe(201);

    for (const id of [frameId, clipId, seqId]) {
      const row = await storedRow(s.sessionId, id);
      expect(row?.uploadedAt).toBeInstanceOf(Date);
      const key = row?.storageKey ?? '';
      expect(key).toMatch(/^evidence\/[\w-]{32}$/);
      expect(key).not.toContain(id);
      expect(key).not.toContain(s.sessionId);
      expect(await ctx.storage.encryption(key)).toBe('AES256');
    }
  });

  it('counts a retried upload once', async () => {
    const { s, frameId } = await sessionWithEvidence();
    expect((await putEvidence(ctx, s, frameId, 'image/jpeg', JPEG)).statusCode).toBe(201);
    const key = (await storedRow(s.sessionId, frameId))?.storageKey;
    const retry = await putEvidence(ctx, s, frameId, 'image/jpeg', JPEG);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ ok: true, duplicate: true });
    expect((await storedRow(s.sessionId, frameId))?.storageKey).toBe(key);
  });

  it('refuses evidence no anomaly manifest references (non-retryable 409)', async () => {
    const s = await startSession(ctx, ctx.orgA);
    const res = await putEvidence(ctx, s, 'unlisted', 'image/jpeg', JPEG);
    expect(res.statusCode).toBe(409);
  });

  it("refuses another session's evidence id", async () => {
    const { frameId } = await sessionWithEvidence();
    const other = await startSession(ctx, ctx.orgA);
    expect((await putEvidence(ctx, other, frameId, 'image/jpeg', JPEG)).statusCode).toBe(409);
  });

  it('refuses bodies that are not what the manifest says (data minimisation)', async () => {
    const { s, frameId, clipId, seqId } = await sessionWithEvidence();
    const cases: [string, string, Buffer | string][] = [
      [frameId, 'audio/wav', WAV], // wrong type for a frame
      [frameId, 'image/jpeg', Buffer.from('not a jpeg at all')],
      [clipId, 'audio/wav', JPEG],
      [
        seqId,
        'application/json',
        JSON.stringify({ from: 0, to: 1, events: [{ type: 'copy', ts: 0, text: 'answer' }] }),
      ],
      [
        seqId,
        'application/json',
        JSON.stringify({ from: 0, to: 1, events: [], url: 'https://exam' }),
      ],
      [seqId, 'text/plain', 'hello'],
    ];
    for (const [id, type, body] of cases) {
      const res = await putEvidence(ctx, s, id, type, body);
      expect([400, 415], `${id} as ${type}`).toContain(res.statusCode);
    }
    for (const id of [frameId, clipId, seqId]) {
      expect((await storedRow(s.sessionId, id))?.uploadedAt).toBeNull();
    }
  });

  it('refuses bodies over MAX_EVIDENCE_BYTES', async () => {
    const { s, frameId } = await sessionWithEvidence();
    const huge = Buffer.concat([JPEG, Buffer.alloc(6 * 1024 * 1024)]);
    expect((await putEvidence(ctx, s, frameId, 'image/jpeg', huge)).statusCode).toBe(413);
  });
});

describe('evidence access', () => {
  it('is only via a short-lived signed URL, issued after an audited check', async () => {
    const { s, frameId } = await sessionWithEvidence();
    await putEvidence(ctx, s, frameId, 'image/jpeg', JPEG);
    const res = await call(ctx.app, ctx.orgA.reviewerToken, {
      method: 'GET',
      url: `/v1/sessions/${s.sessionId}/evidence/${frameId}/url`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ url: string; expiresAt: string; kind: string }>();
    expect(body.kind).toBe('frame');
    expect(new URL(body.url).searchParams.get('X-Amz-Expires')).toBe('60');
    const fetched = await fetch(body.url);
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(JPEG);

    // The object itself is private.
    const unsigned = new URL(body.url);
    unsigned.search = '';
    expect((await fetch(unsigned)).status).toBe(403);

    const audit = await call(ctx.app, ctx.orgA.adminToken, {
      method: 'GET',
      url: '/v1/audit?limit=5',
    });
    const entry = audit
      .json<{ action: string; targetId: string }[]>()
      .find((e) => e.action === 'evidence.view');
    expect(entry?.targetId).toBe(`${s.sessionId}/${frameId}`);
  });

  it('is 404 for evidence that has not been uploaded', async () => {
    const { s, clipId } = await sessionWithEvidence();
    const res = await call(ctx.app, ctx.orgA.reviewerToken, {
      method: 'GET',
      url: `/v1/sessions/${s.sessionId}/evidence/${clipId}/url`,
    });
    expect(res.statusCode).toBe(404);
  });
});
