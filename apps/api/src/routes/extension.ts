import {
  AnomalySchema,
  ConsentRecordSchema,
  EndSessionSchema,
  EventSequenceSchema,
  type SessionInfo,
} from '@proctor/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { audit } from '../audit';
import { requireApiKey, requireSessionToken } from '../auth';
import { consents, evidence, exams, idempotencyKeys, sessions } from '../db/schema';
import { badRequest, conflict, notFound, parse } from '../errors';
import { ingestAnomaly } from '../ingest';
import { effectivePolicy } from '../policies';
import { hashToken, newStorageKey, newToken } from '../security';

// Integrator and extension routes (BUILD_PLAN 5.5). The extension's uploader retries with the
// same Idempotency-Key, so every write here counts exactly once.

const StartSessionSchema = z.strictObject({
  candidateRef: z.string().min(1).max(200),
  examId: z.uuid().optional(),
});

const SessionParams = z.object({ id: z.string().min(1) });
const EvidenceParams = z.object({ id: z.string().min(1), evidenceId: z.string().min(1).max(200) });

/** Content type each evidence kind must be uploaded with. */
const CONTENT_TYPE = {
  frame: 'image/jpeg',
  audio: 'audio/wav',
  event_sequence: 'application/json',
};

function baseType(req: FastifyRequest): string {
  return (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function idempotencyKey(req: FastifyRequest): string | undefined {
  const key = req.headers['idempotency-key'];
  return typeof key === 'string' && key.length > 0 && key.length <= 200 ? key : undefined;
}

function isJpeg(b: Buffer): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function isWav(b: Buffer): boolean {
  return (
    b.length > 44 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE'
  );
}

/** Checks an evidence body is what its manifest says (data minimisation: nothing else). */
function evidenceBody(kind: keyof typeof CONTENT_TYPE, body: unknown): Buffer {
  if (kind === 'event_sequence') {
    const sequence = parse(EventSequenceSchema, body);
    return Buffer.from(JSON.stringify(sequence));
  }
  if (!Buffer.isBuffer(body)) throw badRequest('evidence body missing');
  if (kind === 'frame' ? !isJpeg(body) : !isWav(body)) {
    throw badRequest(`evidence is not a valid ${CONTENT_TYPE[kind]} file`);
  }
  return body;
}

export function registerExtensionRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, config, storage } = deps;

  /** Integrator starts a session: returns the session token and the policy snapshot. */
  app.post('/v1/sessions', async (req, reply) => {
    const key = await requireApiKey(db, req);
    const body = parse(StartSessionSchema, req.body);
    const examId = body.examId ?? null;
    if (examId !== null) {
      const [exam] = await db
        .select({ id: exams.id })
        .from(exams)
        .where(and(eq(exams.id, examId), eq(exams.organisationId, key.organisationId)));
      if (!exam) throw notFound('exam not found');
    }
    const resolved = await effectivePolicy(db, key.organisationId, examId);
    const token = newToken('session');
    const expiresAt = new Date(deps.now().getTime() + config.SESSION_TOKEN_TTL_MS);
    const [session] = await db
      .insert(sessions)
      .values({
        organisationId: key.organisationId,
        examId,
        candidateRef: body.candidateRef,
        tokenHash: hashToken(token),
        tokenExpiresAt: expiresAt,
        policySnapshot: resolved.policy,
        policyVersionId: resolved.versionId,
        startedAt: deps.now(),
      })
      .returning({ id: sessions.id });
    if (!session) throw new Error('session insert returned no row');
    await audit(db, key.actor, {
      action: 'session.create',
      targetType: 'session',
      targetId: session.id,
      details: { examId, policySource: resolved.source, policyVersion: resolved.version },
    });
    return reply.status(201).send({
      sessionId: session.id,
      sessionToken: token,
      expiresAt: expiresAt.toISOString(),
      policySnapshot: resolved.policy,
    });
  });

  /** The extension resolves its token to the session and its policy snapshot. */
  app.get('/v1/sessions/current', async (req): Promise<SessionInfo> => {
    const principal = await requireSessionToken(db, req, deps.now());
    const [session] = await db
      .select({ id: sessions.id, policySnapshot: sessions.policySnapshot })
      .from(sessions)
      .where(eq(sessions.id, principal.sessionId));
    if (!session) throw notFound();
    return { sessionId: session.id, policySnapshot: session.policySnapshot };
  });

  app.post('/v1/sessions/:id/consents', async (req, reply) => {
    const { id } = parse(SessionParams, req.params);
    const principal = await requireSessionToken(db, req, deps.now(), id);
    const record = parse(ConsentRecordSchema, req.body);
    const key = idempotencyKey(req);
    const stored = await db.transaction(async (tx) => {
      if (key !== undefined) {
        const claimed = await tx
          .insert(idempotencyKeys)
          .values({ sessionId: principal.sessionId, key })
          .onConflictDoNothing()
          .returning({ key: idempotencyKeys.key });
        if (claimed.length === 0) return false;
      }
      await tx.insert(consents).values({ sessionId: principal.sessionId, ...record });
      if (record.decision === 'accepted') {
        await tx
          .update(sessions)
          .set({ status: 'active' })
          .where(and(eq(sessions.id, principal.sessionId), eq(sessions.status, 'created')));
      }
      return true;
    });
    return stored
      ? reply.status(201).send({ ok: true })
      : reply.status(200).send({ ok: true, duplicate: true });
  });

  /** Anomaly + evidence manifest. The anomaly id is its idempotency key. */
  app.post('/v1/sessions/:id/anomalies', async (req, reply) => {
    const { id } = parse(SessionParams, req.params);
    const principal = await requireSessionToken(db, req, deps.now(), id);
    const anomaly = parse(AnomalySchema, req.body);
    const result = await ingestAnomaly(db, principal.sessionId, anomaly);
    // Scores are for reviewers only: the candidate's device never receives them.
    return result.duplicate
      ? reply.status(200).send({ ok: true, duplicate: true })
      : reply.status(201).send({ ok: true });
  });

  app.put(
    '/v1/sessions/:id/evidence/:evidenceId',
    { bodyLimit: config.MAX_EVIDENCE_BYTES },
    async (req, reply) => {
      const { id, evidenceId } = parse(EvidenceParams, req.params);
      const principal = await requireSessionToken(db, req, deps.now(), id);
      const where = and(eq(evidence.sessionId, principal.sessionId), eq(evidence.id, evidenceId));
      const [item] = await db.select().from(evidence).where(where);
      // Evidence is accepted only when an anomaly manifest references it.
      if (!item) throw conflict('evidence is not referenced by any anomaly of this session');
      if (item.uploadedAt) return reply.status(200).send({ ok: true, duplicate: true });

      const contentType = CONTENT_TYPE[item.kind];
      if (baseType(req) !== contentType) {
        throw badRequest(`${item.kind} evidence must be uploaded as ${contentType}`);
      }
      const body = evidenceBody(item.kind, req.body);
      const storageKey = newStorageKey();
      await storage.put(storageKey, body, contentType);
      const updated = await db
        .update(evidence)
        .set({ storageKey, contentType, bytes: body.length, uploadedAt: deps.now() })
        .where(and(where, isNull(evidence.uploadedAt)))
        .returning({ id: evidence.id });
      if (updated.length === 0) {
        // A concurrent retry stored it first: keep theirs, remove ours.
        await storage.remove([storageKey]);
        return reply.status(200).send({ ok: true, duplicate: true });
      }
      return reply.status(201).send({ ok: true });
    },
  );

  app.post('/v1/sessions/:id/end', async (req, reply) => {
    const { id } = parse(SessionParams, req.params);
    const principal = await requireSessionToken(db, req, deps.now(), id);
    parse(EndSessionSchema, req.body);
    await db
      .update(sessions)
      .set({ status: 'ended', endedAt: deps.now() })
      .where(and(eq(sessions.id, principal.sessionId), isNull(sessions.endedAt)));
    return reply.status(204).send();
  });
}
