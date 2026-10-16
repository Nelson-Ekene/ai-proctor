import { PolicySchema, type Policy, type Severity, type ViolationType } from '@proctor/core';

// The policy settings form edits a subset of the policy; every other field is kept from the
// loaded version. Weights are edited as percentages that must add up to 100.

export interface PolicyForm {
  weights: { browser: number; video: number; audio: number };
  bands: { lowMax: number; mediumMax: number };
  severityPoints: { low: number; medium: number; high: number };
  severityByType: Record<ViolationType, Severity>;
  framesPerWindow: number;
  windowSeconds: number;
  mergeWindowSeconds: number;
  countMultipliesPoints: boolean;
  eventsBeforeSeconds: number;
  eventsAfterSeconds: number;
  inactivitySeconds: number;
  gazeSustainedSeconds: number;
  minConfidence: number;
  maxClipSeconds: number;
  retentionDays: number;
  faceMatchEnabled: boolean;
  faceMatchMinSimilarity: number;
  faceMatchConsecutiveSamples: number;
}

/** Removes float noise from conversions (0.07 * 100 = 7.000000000000001). */
const clean = (n: number) => Math.round(n * 1e6) / 1e6;

export function toForm(p: Policy): PolicyForm {
  return {
    weights: {
      browser: clean(p.weights.browser * 100),
      video: clean(p.weights.video * 100),
      audio: clean(p.weights.audio * 100),
    },
    bands: { ...p.bands },
    severityPoints: { ...p.severityPoints },
    severityByType: { ...p.severityByType },
    framesPerWindow: p.sampling.framesPerWindow,
    windowSeconds: p.sampling.windowSeconds,
    mergeWindowSeconds: p.merge.windowSeconds,
    countMultipliesPoints: p.merge.countMultipliesPoints,
    eventsBeforeSeconds: p.capture.eventsBeforeSeconds,
    eventsAfterSeconds: p.capture.eventsAfterSeconds,
    inactivitySeconds: p.inactivity.seconds,
    gazeSustainedSeconds: p.gazeAway.sustainedSeconds,
    minConfidence: p.video.minConfidence,
    maxClipSeconds: p.audio.maxClipSeconds,
    retentionDays: p.retentionDays,
    faceMatchEnabled: p.faceMatch.enabled,
    faceMatchMinSimilarity: p.faceMatch.minSimilarity,
    faceMatchConsecutiveSamples: p.faceMatch.consecutiveSamples,
  };
}

/** The form applied on top of `base` (fields the form does not edit are kept). */
export function fromForm(base: Policy, f: PolicyForm): Policy {
  return {
    ...base,
    weights: {
      browser: f.weights.browser / 100,
      video: f.weights.video / 100,
      audio: f.weights.audio / 100,
    },
    bands: { ...f.bands },
    severityPoints: { ...f.severityPoints },
    severityByType: { ...f.severityByType },
    sampling: { framesPerWindow: f.framesPerWindow, windowSeconds: f.windowSeconds },
    merge: { windowSeconds: f.mergeWindowSeconds, countMultipliesPoints: f.countMultipliesPoints },
    capture: {
      ...base.capture,
      eventsBeforeSeconds: f.eventsBeforeSeconds,
      eventsAfterSeconds: f.eventsAfterSeconds,
    },
    inactivity: { ...base.inactivity, seconds: f.inactivitySeconds },
    gazeAway: { ...base.gazeAway, sustainedSeconds: f.gazeSustainedSeconds },
    video: { ...base.video, minConfidence: f.minConfidence },
    audio: { ...base.audio, maxClipSeconds: f.maxClipSeconds },
    retentionDays: f.retentionDays,
    faceMatch: {
      ...base.faceMatch,
      enabled: f.faceMatchEnabled,
      minSimilarity: f.faceMatchMinSimilarity,
      consecutiveSamples: f.faceMatchConsecutiveSamples,
    },
  };
}

export function weightSum(f: PolicyForm): number {
  return clean(f.weights.browser + f.weights.video + f.weights.audio);
}

export type FormCheck = { ok: true; policy: Policy } | { ok: false; problems: string[] };

/** Validates the form: weights must add up to 100, then the full policy schema from core. */
export function checkForm(base: Policy, f: PolicyForm): FormCheck {
  const problems: string[] = [];
  const sum = weightSum(f);
  if (sum !== 100) problems.push(`Weights must add up to 100 (now ${String(sum)}).`);
  const parsed = PolicySchema.safeParse(fromForm(base, f));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      // The weight-sum rule is already reported above, in percent.
      if (issue.path[0] === 'weights' && issue.path.length === 1) continue;
      problems.push(`${issue.path.join('.') || 'policy'}: ${issue.message}`);
    }
  }
  if (problems.length > 0 || !parsed.success) return { ok: false, problems };
  return { ok: true, policy: parsed.data };
}
