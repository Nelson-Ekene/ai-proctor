import { z } from 'zod';
import { categoryOf, type ViolationType } from './catalogue';
import { parsePolicy, type Policy } from './policy';
import { AnomalySchema, type Anomaly, type Violation } from './schemas';

/** Ids are unique once deduplicated, so equality never needs a third outcome. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : 1;
}

/**
 * FR7: anomalies of the same type within `merge.windowSeconds` of the violation's first
 * anomaly become one violation with a count. The window is anchored at firstTs (not chained),
 * so a behaviour repeated all session long still produces one violation per window.
 *
 * Deterministic: input order does not matter, and duplicate anomaly ids (upload retries)
 * are counted once.
 */
export function mergeViolations(anomalies: readonly Anomaly[], policyInput: Policy): Violation[] {
  const policy = parsePolicy(policyInput);
  const parsed = z.array(AnomalySchema).parse(anomalies);
  const windowMs = policy.merge.windowSeconds * 1000;

  const unique = new Map<string, Anomaly>();
  for (const a of parsed) if (!unique.has(a.id)) unique.set(a.id, a);
  const sorted = [...unique.values()].sort((a, b) => a.ts - b.ts || compareIds(a.id, b.id));

  const open = new Map<ViolationType, Violation>();
  const violations: Violation[] = [];

  for (const a of sorted) {
    const current = open.get(a.type);
    if (current && a.ts - current.firstTs <= windowMs) {
      current.lastTs = a.ts;
      current.count += 1;
      current.confidence = Math.max(current.confidence, a.confidence);
      current.anomalyIds.push(a.id);
      for (const e of a.evidence) {
        if (!current.evidence.some((x) => x.id === e.id)) current.evidence.push(e);
      }
      continue;
    }
    const violation: Violation = {
      id: a.id,
      type: a.type,
      category: categoryOf(a.type),
      severity: policy.severityByType[a.type],
      confidence: a.confidence,
      firstTs: a.ts,
      lastTs: a.ts,
      count: 1,
      anomalyIds: [a.id],
      evidence: [...a.evidence],
    };
    open.set(a.type, violation);
    violations.push(violation);
  }

  return violations;
}
