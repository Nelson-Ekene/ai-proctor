import { and, eq, gte, sql, type SQL } from 'drizzle-orm';
import type { Db } from './db/client';
import { consents, evidence, reviewTimes, sessions, violations } from './db/schema';

// Pilot metrics (BUILD_PLAN Phase 9.5), per organisation:
// - share of violations with linked evidence (must be 100%) and share of evidence received
// - setup-check completion rate (sessions that completed setup / sessions that consented)
// - reviewer time per session (visible time on the report, summed per session)

export interface Metrics {
  since: string | null;
  sessions: number;
  violations: { total: number; withEvidence: number; evidenceLinkedRate: number | null };
  evidence: { referenced: number; uploaded: number; uploadedRate: number | null };
  setupCheck: {
    consented: number;
    completed: number;
    completionRate: number | null;
    allReady: number;
  };
  reviewerTime: {
    reviewedSessions: number;
    medianMs: number | null;
    p90Ms: number | null;
    meanMs: number | null;
  };
}

const rate = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000;

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? null;
}

export async function computeMetrics(
  db: Db,
  organisationId: string,
  since: Date | null,
): Promise<Metrics> {
  const scope: SQL[] = [eq(sessions.organisationId, organisationId)];
  if (since) scope.push(gte(sessions.startedAt, since));
  const inScope = and(...scope);

  const [s] = await db
    .select({
      sessions: sql<number>`count(*)::int`,
      completed: sql<number>`count(${sessions.setupCompletedAt})::int`,
      allReady: sql<number>`count(*) filter (where ${sessions.setupResult}->>'face' = 'ready' and ${sessions.setupResult}->>'mic' = 'ready' and ${sessions.setupResult}->>'performance' = 'ready')::int`,
    })
    .from(sessions)
    .where(inScope);

  const [consented] = await db
    .select({ n: sql<number>`count(distinct ${consents.sessionId})::int` })
    .from(consents)
    .innerJoin(sessions, eq(sessions.id, consents.sessionId))
    .where(and(inScope, eq(consents.decision, 'accepted')));

  const [v] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withEvidence: sql<number>`count(*) filter (where jsonb_array_length(${violations.evidence}) > 0)::int`,
    })
    .from(violations)
    .innerJoin(sessions, eq(sessions.id, violations.sessionId))
    .where(inScope);

  const [e] = await db
    .select({
      referenced: sql<number>`count(*)::int`,
      uploaded: sql<number>`count(${evidence.uploadedAt})::int`,
    })
    .from(evidence)
    .innerJoin(sessions, eq(sessions.id, evidence.sessionId))
    .where(inScope);

  const perSession = await db
    .select({ ms: sql<number>`sum(${reviewTimes.ms})::int` })
    .from(reviewTimes)
    .innerJoin(sessions, eq(sessions.id, reviewTimes.sessionId))
    .where(inScope)
    .groupBy(reviewTimes.sessionId);
  const times = perSession.map((r) => r.ms).sort((a, b) => a - b);

  const total = v?.total ?? 0;
  const withEvidence = v?.withEvidence ?? 0;
  const referenced = e?.referenced ?? 0;
  const uploaded = e?.uploaded ?? 0;
  const consentedN = consented?.n ?? 0;
  const completed = s?.completed ?? 0;
  return {
    since: since?.toISOString() ?? null,
    sessions: s?.sessions ?? 0,
    violations: { total, withEvidence, evidenceLinkedRate: rate(withEvidence, total) },
    evidence: { referenced, uploaded, uploadedRate: rate(uploaded, referenced) },
    setupCheck: {
      consented: consentedN,
      completed,
      completionRate: rate(completed, consentedN),
      allReady: s?.allReady ?? 0,
    },
    reviewerTime: {
      reviewedSessions: times.length,
      medianMs: percentile(times, 0.5),
      p90Ms: percentile(times, 0.9),
      meanMs:
        times.length === 0 ? null : Math.round(times.reduce((a, b) => a + b, 0) / times.length),
    },
  };
}
