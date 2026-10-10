import {
  computeRisk,
  mergeViolations,
  type Anomaly,
  type Policy,
  type RiskReport,
  type Violation,
} from '@proctor/core';
import { eq } from 'drizzle-orm';
import type { Db } from './db/client';
import { anomalies, evidence, sessions, violations } from './db/schema';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface IngestResult {
  duplicate: boolean;
}

/**
 * Stores one anomaly (idempotent on its id), registers its evidence manifest, then re-merges
 * all anomalies of the session into violations and recomputes the risk under the session's
 * policy snapshot (core logic only). Serialised per session by a row lock.
 */
export async function ingestAnomaly(
  db: Db,
  sessionId: string,
  anomaly: Anomaly,
): Promise<IngestResult> {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select({ policySnapshot: sessions.policySnapshot })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for('update');
    if (!session) throw new Error(`session ${sessionId} vanished during ingest`);

    const inserted = await tx
      .insert(anomalies)
      .values({
        sessionId,
        id: anomaly.id,
        type: anomaly.type,
        ts: anomaly.ts,
        confidence: anomaly.confidence,
        evidence: anomaly.evidence,
      })
      .onConflictDoNothing()
      .returning({ id: anomalies.id });
    if (inserted.length === 0) return { duplicate: true };

    await tx
      .insert(evidence)
      .values(anomaly.evidence.map((e) => ({ sessionId, id: e.id, kind: e.kind, ts: e.ts })))
      .onConflictDoNothing();

    await rescore(tx, sessionId, session.policySnapshot);
    return { duplicate: false };
  });
}

/** Rebuilds the session's violations and risk from its stored anomalies. */
async function rescore(tx: Tx, sessionId: string, policy: Policy): Promise<RiskReport> {
  const rows = await tx.select().from(anomalies).where(eq(anomalies.sessionId, sessionId));
  const all: Anomaly[] = rows.map((r) => ({
    id: r.id,
    type: r.type as Anomaly['type'],
    ts: r.ts,
    confidence: r.confidence,
    evidence: r.evidence,
  }));
  const merged = mergeViolations(all, policy);
  const report = computeRisk(merged, policy);

  await tx.delete(violations).where(eq(violations.sessionId, sessionId));
  if (merged.length > 0) {
    await tx.insert(violations).values(
      merged.map((v) => ({
        sessionId,
        id: v.id,
        type: v.type,
        category: v.category,
        severity: v.severity,
        confidence: v.confidence,
        firstTs: v.firstTs,
        lastTs: v.lastTs,
        count: v.count,
        anomalyIds: v.anomalyIds,
        evidence: v.evidence,
      })),
    );
  }
  await tx
    .update(sessions)
    .set({ risk: report.risk, band: report.band })
    .where(eq(sessions.id, sessionId));
  return report;
}

/** Stored violations of a session, as core Violation objects, in order of occurrence. */
export async function storedViolations(db: Db, sessionId: string): Promise<Violation[]> {
  const rows = await db.select().from(violations).where(eq(violations.sessionId, sessionId));
  return rows
    .map((r): Violation => ({
      id: r.id,
      type: r.type as Violation['type'],
      category: r.category as Violation['category'],
      severity: r.severity as Violation['severity'],
      confidence: r.confidence,
      firstTs: r.firstTs,
      lastTs: r.lastTs,
      count: r.count,
      anomalyIds: r.anomalyIds,
      evidence: r.evidence,
    }))
    .sort((a, b) => a.firstTs - b.firstTs || (a.id < b.id ? -1 : 1));
}
