import { describe, expect, it } from 'vitest';
import { categoryOf, type ViolationType } from './catalogue';
import { DEFAULT_POLICY, parsePolicy, type Policy } from './policy';
import { RiskReportSchema, type Violation } from './schemas';
import { bandFor, combineCategoryPoints, computeRisk } from './scoring';

let seq = 0;
function violation(type: ViolationType, confidence = 1, count = 1): Violation {
  seq += 1;
  const id = `v${String(seq)}`;
  return {
    id,
    type,
    category: categoryOf(type),
    severity: DEFAULT_POLICY.severityByType[type],
    confidence,
    firstTs: seq * 1000,
    lastTs: seq * 1000 + (count - 1) * 1000,
    count,
    anomalyIds: [id],
    evidence: [{ id: `e-${id}`, kind: 'frame', ts: seq * 1000 }],
  };
}

function withPolicy(patch: Partial<Policy>): Policy {
  return parsePolicy({ ...DEFAULT_POLICY, ...patch });
}

/** Browser 50, video 60, audio 25 under default severities. */
const PRD_SAMPLE: Violation[] = [
  violation('fullscreen_exit'), // 15
  violation('tab_switch_or_blur'), // 15
  violation('copy_paste'), // 5
  violation('copy_paste'), // 5
  violation('refresh_attempt'), // 5
  violation('inactivity'), // 5
  violation('multiple_faces'), // 30
  violation('phone_detected'), // 30
  violation('multiple_voices', 0.5), // 15
  violation('speech_detected', 2 / 3), // 10
];

describe('golden test: PRD illustrative report', () => {
  it('browser 50, video 60, audio 25 at 40/40/20 gives 49.0 Medium', () => {
    const r = combineCategoryPoints({ browser: 50, video: 60, audio: 25 }, DEFAULT_POLICY);
    expect(r.risk).toBe(49);
    expect(r.band).toBe('medium');
    expect(r.categories.map((c) => [c.category, c.weight, c.score, c.contribution])).toEqual([
      ['browser', 0.4, 50, 20],
      ['video', 0.4, 60, 24],
      ['audio', 0.2, 25, 5],
    ]);
  });

  it('reaches the same result from real violations', () => {
    const r = computeRisk(PRD_SAMPLE, DEFAULT_POLICY);
    expect(r.categories.map((c) => c.score)).toEqual([50, 60, 25]);
    expect(r.risk).toBe(49);
    expect(r.band).toBe('medium');
  });
});

describe('computeRisk', () => {
  it('scores an empty session as 0, low', () => {
    const r = computeRisk([], DEFAULT_POLICY);
    expect(r.risk).toBe(0);
    expect(r.band).toBe('low');
    expect(r.violations).toEqual([]);
  });

  it('caps each category at 100 and says so', () => {
    const many = Array.from({ length: 5 }, () => violation('phone_detected')); // 150 raw
    const r = computeRisk(many, DEFAULT_POLICY);
    const video = r.categories.find((c) => c.category === 'video');
    expect(video).toMatchObject({ rawPoints: 150, score: 100, capped: true, contribution: 40 });
    expect(r.risk).toBe(40);
  });

  it('weights points by confidence', () => {
    const r = computeRisk([violation('phone_detected', 0.5)], DEFAULT_POLICY);
    expect(r.violations[0]?.points).toBe(15);
    expect(r.categories[1]?.score).toBe(15);
  });

  it('does not multiply by count by default (open question, policy flag)', () => {
    const merged = violation('copy_paste', 1, 4);
    expect(computeRisk([merged], DEFAULT_POLICY).categories[0]?.score).toBe(5);

    const policy = withPolicy({ merge: { windowSeconds: 60, countMultipliesPoints: true } });
    expect(computeRisk([merged], policy).categories[0]?.score).toBe(20);
  });

  it('takes severity and points from the policy, not from the stored violation', () => {
    const v = violation('copy_paste'); // stored severity: low
    const policy = withPolicy({
      severityByType: { ...DEFAULT_POLICY.severityByType, copy_paste: 'high' },
      severityPoints: { low: 1, medium: 2, high: 40 },
    });
    const r = computeRisk([v], policy);
    expect(r.violations[0]).toMatchObject({ severity: 'high', points: 40 });
  });

  it('applies custom weights', () => {
    const policy = withPolicy({ weights: { browser: 0, video: 0, audio: 1 } });
    const r = computeRisk(PRD_SAMPLE, policy);
    expect(r.risk).toBe(25);
    expect(r.band).toBe('low');
  });

  it('rejects weights that do not sum to 1', () => {
    const bad = { ...DEFAULT_POLICY, weights: { browser: 0.5, video: 0.5, audio: 0.5 } };
    expect(() => computeRisk([], bad)).toThrow(/weights must sum to 1/);
    expect(() => combineCategoryPoints({ browser: 0, video: 0, audio: 0 }, bad)).toThrow();
  });

  it('rejects violations that contradict the catalogue or have bad times', () => {
    const wrongCategory = { ...violation('no_face'), category: 'audio' as const };
    expect(() => computeRisk([wrongCategory], DEFAULT_POLICY)).toThrow(/catalogue/);
    const backwards = { ...violation('no_face'), firstTs: 10, lastTs: 5 };
    expect(() => computeRisk([backwards], DEFAULT_POLICY)).toThrow(/lastTs/);
    const noEvidence = { ...violation('no_face'), evidence: [] };
    expect(() => computeRisk([noEvidence], DEFAULT_POLICY)).toThrow();
  });

  it('is reproducible from violations + the policy snapshot', () => {
    const first = computeRisk(PRD_SAMPLE, DEFAULT_POLICY);
    const stored = JSON.parse(JSON.stringify({ v: PRD_SAMPLE, p: first.policySnapshot })) as {
      v: Violation[];
      p: Policy;
    };
    expect(computeRisk(stored.v, stored.p)).toEqual(first);
  });

  it('returns a report that matches the schema and explains every point', () => {
    const r = computeRisk(PRD_SAMPLE, DEFAULT_POLICY);
    expect(() => RiskReportSchema.parse(r)).not.toThrow();
    expect(r.violations).toHaveLength(PRD_SAMPLE.length);
    for (const c of r.categories) {
      const sum = r.violations
        .filter((v) => v.category === c.category)
        .reduce((acc, v) => acc + v.points, 0);
      expect(sum).toBeCloseTo(c.rawPoints, 1);
    }
    const total = r.categories.reduce((acc, c) => acc + c.contribution, 0);
    expect(total).toBeCloseTo(r.risk, 1);
  });

  it('snapshots the policy rather than referencing the caller object', () => {
    const r = computeRisk([], DEFAULT_POLICY);
    expect(r.policySnapshot).toEqual(DEFAULT_POLICY);
    expect(r.policySnapshot).not.toBe(DEFAULT_POLICY);
  });
});

describe('bands', () => {
  const browserOnly = withPolicy({ weights: { browser: 1, video: 0, audio: 0 } });

  it.each([
    [0, 'low'],
    [29, 'low'],
    [29.01, 'medium'],
    [30, 'medium'],
    [59, 'medium'],
    [59.01, 'high'],
    [60, 'high'],
    [100, 'high'],
  ] as const)('risk %s is %s', (points, band) => {
    expect(combineCategoryPoints({ browser: points, video: 0, audio: 0 }, browserOnly).band).toBe(
      band,
    );
    expect(bandFor(points, DEFAULT_POLICY)).toBe(band);
  });

  it('uses policy thresholds', () => {
    const policy = withPolicy({ bands: { lowMax: 10, mediumMax: 20 } });
    expect(bandFor(15, policy)).toBe('medium');
    expect(bandFor(25, policy)).toBe('high');
  });
});
