import { z } from 'zod';
import { CATEGORIES, categoryOf, type Category } from './catalogue';
import { parsePolicy, type Policy } from './policy';
import {
  ViolationSchema,
  type CategoryResult,
  type RiskBand,
  type RiskReport,
  type Violation,
  type ViolationScore,
} from './schemas';

/** Reported numbers are rounded to 2 dp so float noise never changes a band. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function bandFor(risk: number, policy: Policy): RiskBand {
  if (risk <= policy.bands.lowMax) return 'low';
  if (risk <= policy.bands.mediumMax) return 'medium';
  return 'high';
}

export interface CombinedRisk {
  risk: number;
  band: RiskBand;
  categories: CategoryResult[];
}

/**
 * Risk = w_b*S_b + w_v*S_v + w_a*S_a, with each S_c = min(100, rawPoints_c).
 * Takes raw (uncapped) category points so the cap is applied in exactly one place.
 */
export function combineCategoryPoints(
  rawPoints: Readonly<Record<Category, number>>,
  policyInput: Policy,
): CombinedRisk {
  const policy = parsePolicy(policyInput);
  let risk = 0;
  const categories = CATEGORIES.map((category): CategoryResult => {
    const raw = rawPoints[category];
    const score = Math.min(100, raw);
    const weight = policy.weights[category];
    const contribution = weight * score;
    risk += contribution;
    return {
      category,
      weight,
      rawPoints: round2(raw),
      capped: raw > 100,
      score: round2(score),
      contribution: round2(contribution),
    };
  });
  const rounded = round2(risk);
  return { risk: rounded, band: bandFor(rounded, policy), categories };
}

/**
 * The heart of the product. Pure and reproducible: the same violations and policy snapshot
 * always give the same report.
 *
 * Severity is read from `policy.severityByType` (the policy is the authority), so the same
 * violations can be re-scored under a different policy for "preview score impact".
 */
export function computeRisk(violations: readonly Violation[], policyInput: Policy): RiskReport {
  const policy = parsePolicy(policyInput);
  const parsed = z.array(ViolationSchema).parse(violations);

  const raw: Record<Category, number> = { browser: 0, video: 0, audio: 0 };
  const scores = parsed.map((v): ViolationScore => {
    const severity = policy.severityByType[v.type];
    const multiplier = policy.merge.countMultipliesPoints ? v.count : 1;
    const points = policy.severityPoints[severity] * v.confidence * multiplier;
    const category = categoryOf(v.type);
    raw[category] += points;
    return {
      violationId: v.id,
      type: v.type,
      category,
      severity,
      confidence: v.confidence,
      count: v.count,
      points: round2(points),
    };
  });

  const combined = combineCategoryPoints(raw, policy);
  return { ...combined, violations: scores, policySnapshot: policy };
}
