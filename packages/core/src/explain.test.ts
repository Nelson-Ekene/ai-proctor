import { describe, expect, it } from 'vitest';
import { VIOLATION_TYPES } from './catalogue';
import {
  bandRange,
  describeEvidence,
  explainCategory,
  explainOccurrences,
  explainPoints,
  explainReport,
  explainScoring,
  formatOffset,
  summariseReport,
  violationGuide,
  type ExplainableViolation,
} from './explain';
import { DEFAULT_POLICY, type Policy } from './policy';
import type { CategoryResult } from './schemas';
import { computeRisk } from './scoring';

const VERDICT = /\b(pass(ed)?|fail(ed|s)?|disqualif\w*|block(ed)?|cheat\w*|guilty|end[-_ ]test)\b/i;
const START = Date.UTC(2026, 9, 10, 19, 44, 3);
const MIN = 60_000;

function v(over: Partial<ExplainableViolation> = {}): ExplainableViolation {
  return {
    id: 'v1',
    type: 'phone_detected',
    category: 'video',
    confidence: 0.81,
    count: 1,
    firstTs: START + 9 * MIN,
    lastTs: START + 9 * MIN,
    points: 24.3,
    evidence: [{ kind: 'event_sequence' }, { kind: 'frame' }, { kind: 'frame' }],
    ...over,
  };
}

function category(over: Partial<CategoryResult>): CategoryResult {
  return {
    category: 'video',
    weight: 0.4,
    rawPoints: 0,
    capped: false,
    score: 0,
    contribution: 0,
    ...over,
  };
}

const multiplying: Policy = {
  ...DEFAULT_POLICY,
  merge: { ...DEFAULT_POLICY.merge, countMultipliesPoints: true },
};

describe('violationGuide', () => {
  it('explains every violation type, without verdict words', () => {
    for (const type of VIOLATION_TYPES) {
      const g = violationGuide(type, DEFAULT_POLICY);
      expect(g.meaning.length).toBeGreaterThan(20);
      expect(g.check.length).toBeGreaterThan(20);
      expect(`${g.meaning} ${g.check}`).not.toMatch(VERDICT);
    }
  });

  it('takes thresholds from the policy', () => {
    const p: Policy = {
      ...DEFAULT_POLICY,
      inactivity: { seconds: 90, pingSeconds: 5 },
      gazeAway: { ...DEFAULT_POLICY.gazeAway, sustainedSeconds: 7 },
    };
    expect(violationGuide('inactivity', p).meaning).toContain('90 s');
    expect(violationGuide('gaze_away_sustained', p).meaning).toContain('7 s');
  });
});

describe('describeEvidence', () => {
  it('counts each kind in a stable order', () => {
    expect(describeEvidence(v().evidence)).toBe('2 webcam frames, 1 browser event log');
    expect(describeEvidence([{ kind: 'audio' }, { kind: 'audio' }])).toBe('2 audio clips');
    expect(describeEvidence([{ kind: 'audio' }])).toBe('1 audio clip');
    expect(describeEvidence([])).toBe('no evidence');
  });
});

describe('formatOffset', () => {
  it('formats minutes, hours and clamps negatives', () => {
    expect(formatOffset(START + 5 * MIN, START)).toBe('+05:00');
    expect(formatOffset(START + 62 * MIN + 30_000, START)).toBe('+1:02:30');
    expect(formatOffset(START - 1000, START)).toBe('+00:00');
  });
});

describe('explainPoints', () => {
  it('shows severity points × confidence, using the policy severity', () => {
    expect(explainPoints(v(), DEFAULT_POLICY)).toBe(
      "30 × 0.81 = 24.3 points: High severity is worth 30 points, multiplied by the detector's confidence (81%).",
    );
  });

  it('includes the count when the policy multiplies by it', () => {
    const text = explainPoints(v({ count: 2, points: 48.6 }), multiplying);
    expect(text).toContain('30 × 0.81 × 2 = 48.6 points');
    expect(text).toContain('2 merged occurrences');
  });
});

describe('explainOccurrences', () => {
  it('describes single and merged moments', () => {
    expect(explainOccurrences(v(), DEFAULT_POLICY)).toBe('Happened once.');
    const merged = v({ count: 3, lastTs: START + 9 * MIN + 40_000 });
    expect(explainOccurrences(merged, DEFAULT_POLICY)).toBe(
      'Happened 3 times over 40 s. Repeats within 60 s are merged into one flagged moment and they are counted once.',
    );
    expect(explainOccurrences(merged, multiplying)).toContain('each occurrence adds points');
  });
});

describe('explainCategory', () => {
  it('covers nothing flagged, one, many and capped', () => {
    expect(explainCategory(category({ category: 'audio', weight: 0.2 }), [])).toBe(
      'Audio: nothing flagged, so it adds 0 points (weight 20%).',
    );
    expect(
      explainCategory(category({ rawPoints: 24.3, score: 24.3, contribution: 9.72 }), [v()]),
    ).toBe(
      'Video: 1 flagged moment adds up to 24.3 points. At a weight of 40% it contributes 24.3 × 0.4 = 9.7 points.',
    );
    expect(
      explainCategory(category({ rawPoints: 117.2, capped: true, score: 100, contribution: 40 }), [
        v(),
        v({ id: 'v2' }),
      ]),
    ).toBe(
      'Video: 2 flagged moments add up to 117.2 points, capped at 100. At a weight of 40% it contributes 100.0 × 0.4 = 40.0 points.',
    );
  });
});

describe('bandRange and explainScoring', () => {
  it('describes each band under the policy', () => {
    expect(bandRange('low', DEFAULT_POLICY)).toBe('0 to 29');
    expect(bandRange('medium', DEFAULT_POLICY)).toBe('above 29 up to 59');
    expect(bandRange('high', DEFAULT_POLICY)).toBe('above 59');
  });

  it('states the method with the policy numbers', () => {
    const lines = explainScoring(DEFAULT_POLICY);
    expect(lines[0]).toContain('low 5, medium 15, high 30');
    expect(lines[1]).toContain('counted once');
    expect(lines[3]).toContain('Risk score = browser × 0.4 + video × 0.4 + audio × 0.2');
    expect(explainScoring(multiplying)[1]).toContain('each repeat adds points');
    for (const l of [...lines, ...explainScoring(multiplying)]) expect(l).not.toMatch(VERDICT);
  });
});

describe('summariseReport', () => {
  it('says when nothing was flagged', () => {
    const lines = summariseReport({
      risk: 0,
      band: 'low',
      categories: [],
      violations: [],
      policy: DEFAULT_POLICY,
      startMs: START,
    });
    expect(lines[0]).toContain('scored 0.0 out of 100, in the Low risk band (0 to 29)');
    expect(lines[1]).toBe('Nothing was flagged in this session.');
  });

  it('names the contributing categories, top moments and caps', () => {
    const violations = [
      v(),
      v({ id: 'v2', type: 'multiple_faces', points: 27.6, firstTs: START + 5 * MIN }),
      v({ id: 'v3', type: 'no_face', points: 10.5, firstTs: START + 26 * MIN }),
      v({ id: 'v4', type: 'phone_detected', points: 27.6, firstTs: START + 30 * MIN }),
    ];
    const lines = summariseReport({
      risk: 74.8,
      band: 'high',
      categories: [
        category({ category: 'browser', contribution: 26, score: 65, rawPoints: 65 }),
        category({ contribution: 40, capped: true, score: 100, rawPoints: 117 }),
        category({ category: 'audio', contribution: 0 }),
      ],
      violations,
      policy: DEFAULT_POLICY,
      startMs: START,
    });
    expect(lines[0]).toContain('High risk band (above 59)');
    expect(lines[1]).toBe(
      '4 moments were flagged. The score comes from video (40.0 points), browser (26.0 points).',
    );
    // Ties are broken by time.
    expect(lines[2]).toBe(
      'Highest-scoring moments: More than one person in view at +05:00 (27.6 points); Phone in view at +30:00 (27.6 points); Phone in view at +09:00 (24.3 points).',
    );
    expect(lines[3]).toBe(
      'Video reached the cap of 100, so further flags in that category would not raise the score.',
    );
    for (const l of lines) expect(l).not.toMatch(VERDICT);
  });

  it('handles one moment and several capped categories', () => {
    const lines = summariseReport({
      risk: 80,
      band: 'high',
      categories: [
        category({ category: 'browser', contribution: 40, capped: true }),
        category({ contribution: 40, capped: true }),
      ],
      violations: [v()],
      policy: DEFAULT_POLICY,
      startMs: START,
    });
    expect(lines[1]).toMatch(/^1 moment was flagged\./);
    expect(lines[3]).toContain('Browser and Video reached the cap of 100');
    expect(lines[3]).toContain('those categories');
  });
});

describe('explainReport', () => {
  it('matches computeRisk for the PRD sample violations', () => {
    const stored = [
      {
        id: 'a',
        type: 'tab_switch_or_blur' as const,
        category: 'browser' as const,
        severity: 'medium' as const,
        confidence: 1,
        firstTs: START + MIN,
        lastTs: START + MIN,
        count: 1,
        anomalyIds: ['x'],
        evidence: [{ id: 'e1', kind: 'event_sequence' as const, ts: START + MIN }],
      },
    ];
    const scored = computeRisk(stored, DEFAULT_POLICY);
    const points = new Map(scored.violations.map((s) => [s.violationId, s.points]));
    const report = explainReport({
      risk: scored.risk,
      band: scored.band,
      categories: scored.categories,
      violations: stored.map((s) => ({ ...s, points: points.get(s.id) ?? 0 })),
      policy: DEFAULT_POLICY,
      startMs: START,
    });
    expect(report.categories[0]).toContain('contributes 15.0 × 0.4 = 6.0 points');
    expect(report.violations[0]).toEqual({
      id: 'a',
      offset: '+01:00',
      label: 'Switched tab or window',
      meaning: violationGuide('tab_switch_or_blur', DEFAULT_POLICY).meaning,
      occurrences: 'Happened once.',
      points:
        "15 × 1.00 = 15 points: Medium severity is worth 15 points, multiplied by the detector's confidence (100%).",
      evidence: '1 browser event log',
      check: violationGuide('tab_switch_or_blur', DEFAULT_POLICY).check,
    });
    expect(report.scoring).toHaveLength(4);
    expect(report.summary[0]).toContain('6.0 out of 100');
  });
});
