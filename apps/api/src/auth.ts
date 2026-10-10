import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Actor } from './audit';
import type { Db } from './db/client';
import { apiKeys, sessions, userSessions, users } from './db/schema';
import { forbidden, unauthorised } from './errors';
import { hashToken } from './security';

// Three kinds of caller, each with its own bearer secret (BUILD_PLAN Phase 7.2):
// - integrators: API key, may only start sessions for their organisation
// - the extension: a short-lived session token, scoped to exactly one session
// - dashboard users: a login token, with role admin or reviewer (RBAC below)

export type Role = 'admin' | 'reviewer';

export interface UserPrincipal {
  userId: string;
  organisationId: string;
  role: Role;
  tokenHash: string;
  actor: Actor;
}

export interface SessionPrincipal {
  sessionId: string;
  organisationId: string;
  actor: Actor;
}

export interface ApiKeyPrincipal {
  apiKeyId: string;
  organisationId: string;
  actor: Actor;
}

function bearer(req: FastifyRequest, prefix: string): string {
  const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
  const token = match?.[1];
  if (!token?.startsWith(prefix)) throw unauthorised();
  return token;
}

export async function requireApiKey(db: Db, req: FastifyRequest): Promise<ApiKeyPrincipal> {
  const keyHash = hashToken(bearer(req, 'pak_'));
  const [key] = await db
    .select({ id: apiKeys.id, organisationId: apiKeys.organisationId })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)));
  if (!key) throw unauthorised();
  return {
    apiKeyId: key.id,
    organisationId: key.organisationId,
    actor: { type: 'api_key', id: key.id, organisationId: key.organisationId },
  };
}

/**
 * Resolves the extension's session token. `sessionId`, when given (from the path), must be the
 * token's own session: a token never reaches another session's data.
 */
export async function requireSessionToken(
  db: Db,
  req: FastifyRequest,
  now: Date,
  sessionId?: string,
): Promise<SessionPrincipal> {
  const tokenHash = hashToken(bearer(req, 'pst_'));
  const [session] = await db
    .select({ id: sessions.id, organisationId: sessions.organisationId })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.tokenExpiresAt, now)));
  if (!session) throw unauthorised();
  if (sessionId !== undefined && sessionId !== session.id) throw forbidden();
  return {
    sessionId: session.id,
    organisationId: session.organisationId,
    actor: { type: 'session', id: session.id, organisationId: session.organisationId },
  };
}

/** Dashboard login token with one of `roles` (RBAC). */
export async function requireUser(
  db: Db,
  req: FastifyRequest,
  now: Date,
  roles: readonly Role[] = ['admin', 'reviewer'],
): Promise<UserPrincipal> {
  const tokenHash = hashToken(bearer(req, 'put_'));
  const [row] = await db
    .select({ userId: users.id, organisationId: users.organisationId, role: users.role })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(and(eq(userSessions.tokenHash, tokenHash), gt(userSessions.expiresAt, now)));
  if (!row) throw unauthorised();
  if (!roles.includes(row.role)) throw forbidden();
  return {
    ...row,
    tokenHash,
    actor: { type: 'user', id: row.userId, organisationId: row.organisationId },
  };
}
