import { computeRisk, type Policy, type RiskReport, type Violation } from '@proctor/core';
import type { ReportViolation } from '../api/types';

/** A report's violations as core Violation objects (without the display-only fields). */
export function toCoreViolations(violations: readonly ReportViolation[]): Violation[] {
  return violations.map((v) => ({
    id: v.id,
    type: v.type,
    category: v.category,
    severity: v.severity,
    confidence: v.confidence,
    firstTs: v.firstTs,
    lastTs: v.lastTs,
    count: v.count,
    anomalyIds: v.anomalyIds,
    evidence: v.evidence.map((e) => ({ id: e.id, kind: e.kind, ts: e.ts })),
  }));
}

export interface ScoreImpact {
  current: RiskReport;
  preview: RiskReport;
  delta: number;
}

/**
 * "Preview score impact": the same violations re-scored under the draft policy with the core
 * scoring function, so the preview equals what the server computes. Merging is not redone: a new
 * merge window only applies to sessions that start under it.
 */
export function scoreImpact(
  violations: readonly ReportViolation[],
  current: Policy,
  draft: Policy,
): ScoreImpact {
  const core = toCoreViolations(violations);
  const before = computeRisk(core, current);
  const after = computeRisk(core, draft);
  return {
    current: before,
    preview: after,
    delta: Math.round((after.risk - before.risk) * 100) / 100,
  };
}
