import { z } from 'zod';
import { CATEGORIES, categoryOf } from './catalogue';
import { PolicySchema, SeveritySchema, ViolationTypeSchema } from './policy';

export const CategorySchema = z.enum(CATEGORIES);

/** Epoch milliseconds. */
const timestamp = z.number().nonnegative();
const confidence = z.number().min(0).max(1);
const id = z.string().min(1);

export const EVIDENCE_KINDS = ['frame', 'audio', 'event_sequence'] as const;
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);

/** Reference to an evidence item. Storage location is a backend concern. */
export const EvidenceRefSchema = z.strictObject({
  id,
  kind: EvidenceKindSchema,
  ts: timestamp,
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/** What a detector emits, before the orchestrator packages evidence. */
export const DetectedAnomalySchema = z.strictObject({
  type: ViolationTypeSchema,
  ts: timestamp,
  confidence,
});
export type DetectedAnomaly = z.infer<typeof DetectedAnomalySchema>;

/**
 * An anomaly held on the device before packaging (Phase 6). Video anomalies already reference
 * their frames; browser anomalies get their event sequence when the capture window closes.
 */
export const PendingAnomalySchema = DetectedAnomalySchema.extend({
  evidence: z.array(EvidenceRefSchema).optional(),
});
export type PendingAnomaly = z.infer<typeof PendingAnomalySchema>;

/** An anomaly as uploaded: it always carries evidence. `id` doubles as the idempotency key. */
export const AnomalySchema = DetectedAnomalySchema.extend({
  id,
  evidence: z.array(EvidenceRefSchema).min(1),
});
export type Anomaly = z.infer<typeof AnomalySchema>;

export const ViolationSchema = z
  .strictObject({
    id,
    type: ViolationTypeSchema,
    category: CategorySchema,
    severity: SeveritySchema,
    confidence,
    firstTs: timestamp,
    lastTs: timestamp,
    count: z.number().int().positive(),
    anomalyIds: z.array(id).min(1),
    evidence: z.array(EvidenceRefSchema).min(1),
  })
  .refine((v) => v.category === categoryOf(v.type), {
    message: 'category does not match the violation catalogue',
    path: ['category'],
  })
  .refine((v) => v.lastTs >= v.firstTs, { message: 'lastTs before firstTs', path: ['lastTs'] });
export type Violation = z.infer<typeof ViolationSchema>;

export const RISK_BANDS = ['low', 'medium', 'high'] as const;
export const RiskBandSchema = z.enum(RISK_BANDS);
export type RiskBand = z.infer<typeof RiskBandSchema>;

export const CategoryResultSchema = z.strictObject({
  category: CategorySchema,
  weight: z.number(),
  /** Sum of violation points before the 100 cap. */
  rawPoints: z.number(),
  capped: z.boolean(),
  score: z.number(),
  contribution: z.number(),
});
export type CategoryResult = z.infer<typeof CategoryResultSchema>;

/** How one violation contributed to its category score (pre-cap). */
export const ViolationScoreSchema = z.strictObject({
  violationId: id,
  type: ViolationTypeSchema,
  category: CategorySchema,
  severity: SeveritySchema,
  confidence,
  count: z.number().int().positive(),
  points: z.number(),
});
export type ViolationScore = z.infer<typeof ViolationScoreSchema>;

export const RiskReportSchema = z.strictObject({
  risk: z.number().min(0).max(100),
  band: RiskBandSchema,
  categories: z.array(CategoryResultSchema).length(CATEGORIES.length),
  violations: z.array(ViolationScoreSchema),
  policySnapshot: PolicySchema,
});
export type RiskReport = z.infer<typeof RiskReportSchema>;
