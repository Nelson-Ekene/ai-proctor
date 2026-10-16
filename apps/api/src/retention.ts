import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { audit, SYSTEM } from './audit';
import type { Db } from './db/client';
import { evidence, organisations, sessions, userSessions } from './db/schema';
import { REGION_CONFIG, REGIONS } from './regions';
import type { EvidenceStorage } from './storage';

/**
 * Deletes a session and everything about it: its evidence objects first, then the session row,
 * which cascades to its anomalies, violations, evidence records, consents and review times. If
 * the objects cannot be deleted, this throws before the row is touched, so nothing is orphaned.
 * The audit trail is kept. Returns the number of evidence objects deleted.
 */
export async function deleteSession(
  db: Db,
  storage: EvidenceStorage,
  sessionId: string,
): Promise<number> {
  const objects = await db
    .select({ key: evidence.storageKey })
    .from(evidence)
    .where(and(eq(evidence.sessionId, sessionId), isNotNull(evidence.storageKey)));
  const keys = objects.flatMap((o) => (o.key ? [o.key] : []));
  await storage.remove(keys);
  await db.delete(sessions).where(eq(sessions.id, sessionId));
  return keys.length;
}

export interface RetentionResult {
  sessionsDeleted: number;
  objectsDeleted: number;
  failures: number;
}

/**
 * Deletes every session (with its anomalies, violations, consents and evidence objects) whose
 * retention period has passed: `retentionDays` of the session's own policy snapshot (capped by
 * the organisation's region), counted
 * from the session end (or start, if it never ended). Each deletion is audit-logged; the audit
 * trail itself is kept. A session whose objects cannot be deleted is kept and retried next run.
 */
export async function runRetention(
  db: Db,
  storage: EvidenceStorage,
  now: Date,
  log: (message: string) => void = () => undefined,
): Promise<RetentionResult> {
  // The region caps retention whatever the policy says (regions.ts).
  const regionMax = sql.join(
    REGIONS.map((r) => sql`when ${r} then ${REGION_CONFIG[r].maxRetentionDays}::int`),
    sql` `,
  );
  const days = sql`least(
    (${sessions.policySnapshot}->>'retentionDays')::int,
    case ${organisations.region}::text ${regionMax} end
  )`;
  const expired = await db
    .select({ id: sessions.id, organisationId: sessions.organisationId })
    .from(sessions)
    .innerJoin(organisations, eq(organisations.id, sessions.organisationId))
    .where(
      sql`coalesce(${sessions.endedAt}, ${sessions.startedAt})
        + make_interval(days => ${days})
        < ${now.toISOString()}::timestamptz`,
    );

  const result: RetentionResult = { sessionsDeleted: 0, objectsDeleted: 0, failures: 0 };
  for (const session of expired) {
    try {
      const objects = await deleteSession(db, storage, session.id);
      await audit(db, SYSTEM, {
        action: 'retention.delete',
        organisationId: session.organisationId,
        targetType: 'session',
        targetId: session.id,
        details: { evidenceObjects: objects },
      });
      result.sessionsDeleted += 1;
      result.objectsDeleted += objects;
    } catch (error) {
      result.failures += 1;
      log(`retention: session ${session.id} kept for the next run: ${String(error)}`);
    }
  }

  await db.delete(userSessions).where(lt(userSessions.expiresAt, now));
  return result;
}
