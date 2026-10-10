import { EventSequenceSchema, PolicySchema, RiskBandSchema } from '@proctor/core';
import { and, count, desc, eq, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { audit } from '../audit';
import { requireUser, type UserPrincipal } from '../auth';
import { apiKeys, auditLog, evidence, exams, sessions, userSessions, users } from '../db/schema';
import { conflict, notFound, parse, unauthorised } from '../errors';
import { appendVersion, effectivePolicy, isUniqueViolation, listVersions } from '../policies';
import { buildReport, renderReportPdf } from '../report';
import { dummyPasswordHash, hashPassword, hashToken, newToken, verifyPassword } from '../security';

// Dashboard routes (reviewer/admin). Every read of a session, report, export or evidence and
// every policy change writes an audit row before the data is returned (FR14).

const LoginSchema = z.strictObject({
  email: z.email().max(320),
  password: z.string().min(1).max(1024),
});

const ListSessionsQuery = z.object({
  band: RiskBandSchema.optional(),
  examId: z.uuid().optional(),
  status: z.enum(['created', 'active', 'ended']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const UuidParams = z.object({ id: z.uuid() });
const EvidenceUrlParams = z.object({ id: z.uuid(), evidenceId: z.string().min(1).max(200) });
const PolicyQuery = z.object({ examId: z.uuid().optional() });
const PutPolicySchema = z.strictObject({
  examId: z.uuid().nullable().optional(),
  policy: z.unknown(),
});
const CreateExamSchema = z.strictObject({ name: z.string().min(1).max(200) });
const CreateApiKeySchema = z.strictObject({ label: z.string().min(1).max(200) });
const CreateUserSchema = z.strictObject({
  email: z.email().max(320),
  password: z.string().min(12).max(1024),
  role: z.enum(['admin', 'reviewer']),
});
const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.iso.datetime().optional(),
});

export function registerDashboardRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, config, storage } = deps;
  const user = (
    req: Parameters<typeof requireUser>[1],
    roles?: readonly ('admin' | 'reviewer')[],
  ) => requireUser(db, req, deps.now(), roles);
  const admin = (req: Parameters<typeof requireUser>[1]) => user(req, ['admin']);

  /** A session of the caller's organisation, or 404 (never reveals other organisations' ids). */
  async function ownSession(principal: UserPrincipal, id: string) {
    const [session] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.organisationId, principal.organisationId)));
    if (!session) throw notFound('session not found');
    return session;
  }

  async function ownExam(principal: UserPrincipal, id: string) {
    const [exam] = await db
      .select({ id: exams.id })
      .from(exams)
      .where(and(eq(exams.id, id), eq(exams.organisationId, principal.organisationId)));
    if (!exam) throw notFound('exam not found');
    return exam;
  }

  // --- auth ---------------------------------------------------------------------------------

  app.post('/v1/auth/login', async (req) => {
    const { email, password } = parse(LoginSchema, req.body);
    const [found] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    // Unknown e-mails still pay for a hash check, so timing does not reveal accounts.
    const ok = await verifyPassword(password, found?.passwordHash ?? (await dummyPasswordHash()));
    if (!found || !ok) throw unauthorised();
    const token = newToken('user');
    const expiresAt = new Date(deps.now().getTime() + config.USER_TOKEN_TTL_MS);
    await db
      .insert(userSessions)
      .values({ userId: found.id, tokenHash: hashToken(token), expiresAt });
    await audit(
      db,
      { type: 'user', id: found.id, organisationId: found.organisationId },
      { action: 'auth.login', targetType: 'user', targetId: found.id },
    );
    return { token, expiresAt: expiresAt.toISOString(), role: found.role };
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const principal = await user(req);
    await db.delete(userSessions).where(eq(userSessions.tokenHash, principal.tokenHash));
    return reply.status(204).send();
  });

  app.get('/v1/me', async (req) => {
    const principal = await user(req);
    const [me] = await db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        organisationId: users.organisationId,
      })
      .from(users)
      .where(eq(users.id, principal.userId));
    return me;
  });

  // --- sessions and reports -----------------------------------------------------------------

  /** Sessions ranked by risk (highest first). */
  app.get('/v1/sessions', async (req) => {
    const principal = await user(req);
    const q = parse(ListSessionsQuery, req.query);
    const filters: SQL[] = [eq(sessions.organisationId, principal.organisationId)];
    if (q.band) filters.push(eq(sessions.band, q.band));
    if (q.examId) filters.push(eq(sessions.examId, q.examId));
    if (q.status) filters.push(eq(sessions.status, q.status));
    const where = and(...filters);
    const rows = await db
      .select({
        id: sessions.id,
        examId: sessions.examId,
        candidateRef: sessions.candidateRef,
        status: sessions.status,
        startedAt: sessions.startedAt,
        endedAt: sessions.endedAt,
        risk: sessions.risk,
        band: sessions.band,
        // Qualified explicitly: inside the subquery an unqualified "id" would mean violations.id.
        violationCount: sql<number>`(select count(*)::int from "violations" v where v."session_id" = "sessions"."id")`,
      })
      .from(sessions)
      .where(where)
      .orderBy(desc(sessions.risk), desc(sessions.startedAt))
      .limit(q.limit)
      .offset(q.offset);
    const [total] = await db.select({ n: count() }).from(sessions).where(where);
    await audit(db, principal.actor, {
      action: 'sessions.list',
      details: { band: q.band, examId: q.examId, status: q.status, returned: rows.length },
    });
    return { sessions: rows, total: total?.n ?? 0 };
  });

  async function report(principal: UserPrincipal, id: string, action: string, format?: string) {
    await ownSession(principal, id);
    await audit(db, principal.actor, {
      action,
      targetType: 'session',
      targetId: id,
      ...(format ? { details: { format } } : {}),
    });
    const built = await buildReport(db, id, deps.now());
    if (!built) throw notFound('session not found');
    return built;
  }

  app.get('/v1/sessions/:id/report', async (req) => {
    const principal = await user(req);
    const { id } = parse(UuidParams, req.params);
    return report(principal, id, 'report.view');
  });

  app.get('/v1/sessions/:id/report.json', async (req, reply) => {
    const principal = await user(req);
    const { id } = parse(UuidParams, req.params);
    const built = await report(principal, id, 'report.export', 'json');
    return reply
      .header('content-disposition', `attachment; filename="session-${id}.json"`)
      .send(built);
  });

  app.get('/v1/sessions/:id/report.pdf', async (req, reply) => {
    const principal = await user(req);
    const { id } = parse(UuidParams, req.params);
    const pdf = await renderReportPdf(await report(principal, id, 'report.export', 'pdf'));
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="session-${id}.pdf"`)
      .send(pdf);
  });

  /** An uploaded evidence item of the caller's organisation, audited before it is returned. */
  async function viewEvidence(principal: UserPrincipal, id: string, evidenceId: string) {
    await ownSession(principal, id);
    const [item] = await db
      .select()
      .from(evidence)
      .where(and(eq(evidence.sessionId, id), eq(evidence.id, evidenceId)));
    if (!item?.storageKey) throw notFound('evidence not uploaded');
    await audit(db, principal.actor, {
      action: 'evidence.view',
      targetType: 'evidence',
      targetId: `${id}/${evidenceId}`,
      details: { kind: item.kind },
    });
    return { ...item, storageKey: item.storageKey };
  }

  /** A short-lived signed URL for one evidence item, issued after an audited access check. */
  app.get('/v1/sessions/:id/evidence/:evidenceId/url', async (req) => {
    const principal = await user(req);
    const { id, evidenceId } = parse(EvidenceUrlParams, req.params);
    const item = await viewEvidence(principal, id, evidenceId);
    const ttl = config.EVIDENCE_URL_TTL_SECONDS;
    return {
      url: await storage.signedUrl(item.storageKey, ttl),
      expiresAt: new Date(deps.now().getTime() + ttl * 1000).toISOString(),
      kind: item.kind,
      contentType: item.contentType,
    };
  });

  /** The browser event sequence of an anomaly (event type + timestamp only), audited. */
  app.get('/v1/sessions/:id/evidence/:evidenceId/events', async (req) => {
    const principal = await user(req);
    const { id, evidenceId } = parse(EvidenceUrlParams, req.params);
    const item = await viewEvidence(principal, id, evidenceId);
    if (item.kind !== 'event_sequence') throw notFound('not an event sequence');
    const raw: unknown = JSON.parse((await storage.get(item.storageKey)).toString('utf8'));
    return EventSequenceSchema.parse(raw);
  });

  // --- policies -----------------------------------------------------------------------------

  app.get('/v1/policies', async (req) => {
    const principal = await user(req);
    const { examId } = parse(PolicyQuery, req.query);
    if (examId) await ownExam(principal, examId);
    const scope = { organisationId: principal.organisationId, examId: examId ?? null };
    return {
      examId: examId ?? null,
      effective: await effectivePolicy(db, scope.organisationId, scope.examId),
      versions: await listVersions(db, scope),
    };
  });

  /** Saves a new policy version (organisation default, or an exam override with `examId`). */
  app.put('/v1/policies', async (req) => {
    const principal = await admin(req);
    const body = parse(PutPolicySchema, req.body);
    const examId = body.examId ?? null;
    if (examId) await ownExam(principal, examId);
    const policy = parse(PolicySchema, body.policy);
    const saved = await appendVersion(
      db,
      { organisationId: principal.organisationId, examId },
      policy,
      principal.userId,
    );
    await audit(db, principal.actor, {
      action: 'policy.update',
      targetType: examId ? 'exam_policy' : 'organisation_policy',
      targetId: examId ?? principal.organisationId,
      details: { version: saved.version, policyId: saved.id },
    });
    return { ...saved, examId, policy };
  });

  /** Removes an exam override (a new version that inherits the organisation default). */
  app.delete('/v1/policies/exams/:id', async (req) => {
    const principal = await admin(req);
    const { id } = parse(UuidParams, req.params);
    await ownExam(principal, id);
    const current = await effectivePolicy(db, principal.organisationId, id);
    if (current.source !== 'exam') throw notFound('exam has no policy override');
    const saved = await appendVersion(
      db,
      { organisationId: principal.organisationId, examId: id },
      null,
      principal.userId,
    );
    await audit(db, principal.actor, {
      action: 'policy.override_removed',
      targetType: 'exam_policy',
      targetId: id,
      details: { version: saved.version },
    });
    return saved;
  });

  // --- organisation administration ----------------------------------------------------------

  app.get('/v1/exams', async (req) => {
    const principal = await user(req);
    return db
      .select()
      .from(exams)
      .where(eq(exams.organisationId, principal.organisationId))
      .orderBy(desc(exams.createdAt));
  });

  app.post('/v1/exams', async (req, reply) => {
    const principal = await admin(req);
    const { name } = parse(CreateExamSchema, req.body);
    const [exam] = await db
      .insert(exams)
      .values({ organisationId: principal.organisationId, name })
      .returning();
    await audit(db, principal.actor, {
      action: 'exam.create',
      targetType: 'exam',
      targetId: exam?.id,
    });
    return reply.status(201).send(exam);
  });

  app.get('/v1/api-keys', async (req) => {
    const principal = await admin(req);
    return db
      .select({
        id: apiKeys.id,
        label: apiKeys.label,
        createdAt: apiKeys.createdAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.organisationId, principal.organisationId))
      .orderBy(desc(apiKeys.createdAt));
  });

  /** The key is returned once; only its hash is stored. */
  app.post('/v1/api-keys', async (req, reply) => {
    const principal = await admin(req);
    const { label } = parse(CreateApiKeySchema, req.body);
    const key = newToken('api_key');
    const [row] = await db
      .insert(apiKeys)
      .values({ organisationId: principal.organisationId, label, keyHash: hashToken(key) })
      .returning({ id: apiKeys.id });
    await audit(db, principal.actor, {
      action: 'api_key.create',
      targetType: 'api_key',
      targetId: row?.id,
    });
    return reply.status(201).send({ id: row?.id, label, key });
  });

  app.delete('/v1/api-keys/:id', async (req, reply) => {
    const principal = await admin(req);
    const { id } = parse(UuidParams, req.params);
    const revoked = await db
      .update(apiKeys)
      .set({ revokedAt: deps.now() })
      .where(
        and(
          eq(apiKeys.id, id),
          eq(apiKeys.organisationId, principal.organisationId),
          isNull(apiKeys.revokedAt),
        ),
      )
      .returning({ id: apiKeys.id });
    if (revoked.length === 0) throw notFound('api key not found');
    await audit(db, principal.actor, {
      action: 'api_key.revoke',
      targetType: 'api_key',
      targetId: id,
    });
    return reply.status(204).send();
  });

  app.get('/v1/users', async (req) => {
    const principal = await admin(req);
    return db
      .select({ id: users.id, email: users.email, role: users.role, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.organisationId, principal.organisationId));
  });

  app.post('/v1/users', async (req, reply) => {
    const principal = await admin(req);
    const body = parse(CreateUserSchema, req.body);
    try {
      const [created] = await db
        .insert(users)
        .values({
          organisationId: principal.organisationId,
          email: body.email.toLowerCase(),
          passwordHash: await hashPassword(body.password),
          role: body.role,
        })
        .returning({ id: users.id, email: users.email, role: users.role });
      await audit(db, principal.actor, {
        action: 'user.create',
        targetType: 'user',
        targetId: created?.id,
        details: { role: body.role },
      });
      return await reply.status(201).send(created);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('a user with this e-mail already exists');
      throw error;
    }
  });

  app.get('/v1/audit', async (req) => {
    const principal = await admin(req);
    const q = parse(AuditQuery, req.query);
    const filters: SQL[] = [eq(auditLog.organisationId, principal.organisationId)];
    if (q.before) filters.push(lt(auditLog.ts, new Date(q.before)));
    return db
      .select()
      .from(auditLog)
      .where(and(...filters))
      .orderBy(desc(auditLog.ts))
      .limit(q.limit);
  });
}
