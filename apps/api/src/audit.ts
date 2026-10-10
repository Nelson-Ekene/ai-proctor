import type { Db } from './db/client';
import { auditLog } from './db/schema';

export interface Actor {
  type: 'user' | 'api_key' | 'session' | 'system';
  id: string | null;
  organisationId: string | null;
}

export const SYSTEM: Actor = { type: 'system', id: null, organisationId: null };

export interface AuditEntry {
  action: string;
  targetType?: string | undefined;
  targetId?: string | undefined;
  details?: Record<string, unknown> | undefined;
  /** Overrides the actor's organisation (system jobs acting on one organisation's data). */
  organisationId?: string;
}

/** Appends one audit row (FR14). Callers write it before returning the audited data. */
export async function audit(db: Db, actor: Actor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    organisationId: entry.organisationId ?? actor.organisationId,
    actorType: actor.type,
    actorId: actor.id,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    details: entry.details ?? null,
  });
}
