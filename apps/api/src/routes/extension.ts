import {
  AnomalySchema,
  ConsentRecordSchema,
  EndSessionSchema,
  SetupCheckRecordSchema,
  type SessionInfo,
} from '@proctor/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { audit } from '../audit';
import { requireApiKey, requireSessionToken } from '../auth';
import { consents, exams, idempotencyKeys, organisations, sessions } from '../db/schema';
import { notFound, parse, unprocessable } from '../errors';
import { storeEvidence } from '../evidence';
import { ingestAnomaly } from '../ingest';
import { effectivePolicy } from '../policies';
import { REGION_CONFIG } from '../regions';
import { hashToken, newToken } from '../security';

// Integrator and extension routes (BUILD_PLAN 5.5). The extension's uploader retries with the
// same Idempotency-Key, so every write here counts exactly once.

const StartSessionSchema = z.strictObject({
  candidateRef: z.string().min(1).max(200),
  examId: z.uuid().optional(),
});

const SessionParams = z.object({ id: z.string().min(1) });
const EvidenceParams = z.object({ id: z.string().min(1), evidenceId: z.string().min(1).max(200) });

function baseType(req: FastifyRequest): string {
  return (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function idempotencyKey(req: FastifyRequest): string | undefined {
  const key = req.headers['idempotency-key'];
  return typeof key === 'string' && key.length > 0 && key.length <= 200 ? key : undefined;
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
    const [org] = await db
      .select({ region: organisations.region })
      .from(organisations)
      .where(eq(organisations.id, principal.organisationId));
    const region = REGION_CONFIG[org?.region ?? 'eu'];
    if (!region.consentNoticeVersions.includes(record.noticeVersion)) {
      // Non-retryable: capture must not start under a notice that is not valid in this region.
      throw unprocessable(`consent notice ${record.noticeVersion} is not valid in ${region.label}`);
    }
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
      const result = await storeEvidence(db, storage, {
        sessionId: principal.sessionId,
        evidenceId,
        contentType: baseType(req),
        body: req.body,
        now: deps.now(),
      });
      if (result.duplicate) return reply.status(200).send({ ok: true, duplicate: true });
      return reply.status(201).send({ ok: true });
    },
  );

  /** Setup-check outcome (device check, never an exam result); the first record counts. */
  app.post('/v1/sessions/:id/setup-check', async (req, reply) => {
    const { id } = parse(SessionParams, req.params);
    const principal = await requireSessionToken(db, req, deps.now(), id);
    const record = parse(SetupCheckRecordSchema, req.body);
    const updated = await db
      .update(sessions)
      .set({ setupResult: record.result, setupCompletedAt: deps.now() })
      .where(and(eq(sessions.id, principal.sessionId), isNull(sessions.setupCompletedAt)))
      .returning({ id: sessions.id });
    return updated.length > 0
      ? reply.status(201).send({ ok: true })
      : reply.status(200).send({ ok: true, duplicate: true });
  });

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
