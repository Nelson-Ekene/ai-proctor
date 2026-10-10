import { DEFAULT_POLICY, parsePolicy, type Policy } from '@proctor/core';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from './db/client';
import { policies } from './db/schema';
import { conflict } from './errors';

// Policy resolution (BUILD_PLAN 9.4): the latest per-exam override, else the latest
// organisation default, else DEFAULT_POLICY. Versions are append-only.

export type PolicySource = 'exam' | 'organisation' | 'default';

export interface EffectivePolicy {
  policy: Policy;
  versionId: string | null;
  version: number | null;
  source: PolicySource;
}

type Scope = { organisationId: string; examId: string | null };

function scopeWhere({ organisationId, examId }: Scope) {
  return and(
    eq(policies.organisationId, organisationId),
    examId === null ? isNull(policies.examId) : eq(policies.examId, examId),
  );
}

async function latest(db: Db, scope: Scope) {
  const [row] = await db
    .select()
    .from(policies)
    .where(scopeWhere(scope))
    .orderBy(desc(policies.version))
    .limit(1);
  return row;
}

export async function effectivePolicy(
  db: Db,
  organisationId: string,
  examId: string | null,
): Promise<EffectivePolicy> {
  if (examId !== null) {
    const override = await latest(db, { organisationId, examId });
    if (override?.policy) {
      return {
        policy: parsePolicy(override.policy),
        versionId: override.id,
        version: override.version,
        source: 'exam',
      };
    }
  }
  const org = await latest(db, { organisationId, examId: null });
  if (org?.policy) {
    return {
      policy: parsePolicy(org.policy),
      versionId: org.id,
      version: org.version,
      source: 'organisation',
    };
  }
  return { policy: parsePolicy(DEFAULT_POLICY), versionId: null, version: null, source: 'default' };
}

export async function listVersions(db: Db, scope: Scope) {
  return db
    .select({
      id: policies.id,
      version: policies.version,
      policy: policies.policy,
      createdBy: policies.createdBy,
      createdAt: policies.createdAt,
    })
    .from(policies)
    .where(scopeWhere(scope))
    .orderBy(desc(policies.version));
}

/**
 * Appends a new version for the scope. `policy: null` (exam scope only) removes the override.
 * The policy must already be validated (parsePolicy).
 */
export async function appendVersion(
  db: Db,
  scope: Scope,
  policy: Policy | null,
  createdBy: string,
): Promise<{ id: string; version: number }> {
  const next = sql<number>`coalesce((select max(${policies.version}) from ${policies} where ${scopeWhere(scope)}), 0) + 1`;
  try {
    const [row] = await db
      .insert(policies)
      .values({ ...scope, version: next, policy, createdBy })
      .returning({ id: policies.id, version: policies.version });
    if (!row) throw new Error('policy insert returned no row');
    return row;
  } catch (error) {
    // Two concurrent changes computed the same version: the unique index rejects one.
    if (isUniqueViolation(error)) throw conflict('policy changed concurrently, retry');
    throw error;
  }
}

export function isUniqueViolation(error: unknown): boolean {
  const cause = error instanceof Error && 'cause' in error ? error.cause : error;
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === '23505';
}
