import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { audit, SYSTEM } from './audit';
import type { Db } from './db/client';
import { evidence, sessions, userSessions } from './db/schema';
import type { EvidenceStorage } from './storage';

export interface RetentionResult {
  sessionsDeleted: number;
  objectsDeleted: number;
  failures: number;
}

/**
 * Deletes every session (with its anomalies, violations, consents and evidence objects) whose
 * retention period has passed: `retentionDays` of the session's own policy snapshot, counted
 * from the session end (or start, if it never ended). Each deletion is audit-logged; the audit
 * trail itself is kept. A session whose objects cannot be deleted is kept and retried next run.
 */
export async function runRetention(
  db: Db,
  storage: EvidenceStorage,
  now: Date,
  log: (message: string) => void = () => undefined,
): Promise<RetentionResult> {
  const expired = await db
    .select({ id: sessions.id, organisationId: sessions.organisationId })
    .from(sessions)
    .where(
      sql`coalesce(${sessions.endedAt}, ${sessions.startedAt})
        + make_interval(days => (${sessions.policySnapshot}->>'retentionDays')::int)
        < ${now.toISOString()}::timestamptz`,
    );

  const result: RetentionResult = { sessionsDeleted: 0, objectsDeleted: 0, failures: 0 };
  for (const session of expired) {
    try {
      const objects = await db
        .select({ key: evidence.storageKey })
        .from(evidence)
        .where(and(eq(evidence.sessionId, session.id), isNotNull(evidence.storageKey)));
      const keys = objects.flatMap((o) => (o.key ? [o.key] : []));
      await storage.remove(keys);
      await db.delete(sessions).where(eq(sessions.id, session.id));
      await audit(db, SYSTEM, {
        action: 'retention.delete',
        organisationId: session.organisationId,
        targetType: 'session',
        targetId: session.id,
        details: { evidenceObjects: keys.length },
      });
      result.sessionsDeleted += 1;
      result.objectsDeleted += keys.length;
    } catch (error) {
      result.failures += 1;
      log(`retention: session ${session.id} kept for the next run: ${String(error)}`);
    }
  }

  await db.delete(userSessions).where(lt(userSessions.expiresAt, now));
  return result;
}
