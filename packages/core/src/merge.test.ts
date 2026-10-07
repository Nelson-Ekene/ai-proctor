import { describe, expect, it } from 'vitest';
import type { ViolationType } from './catalogue';
import { mergeViolations } from './merge';
import { DEFAULT_POLICY, parsePolicy } from './policy';
import { createRuleEngineState, stepRuleEngine } from './rules';
import { ViolationSchema, type Anomaly } from './schemas';

const S = 1000;

function anomaly(id: string, type: ViolationType, ts: number, confidence = 1): Anomaly {
  return { id, type, ts, confidence, evidence: [{ id: `e-${id}`, kind: 'event_sequence', ts }] };
}

describe('mergeViolations', () => {
  it('merges same-type anomalies within the window into one violation with a count', () => {
    const [v, ...rest] = mergeViolations(
      [
        anomaly('a1', 'no_face', 0, 0.6),
        anomaly('a2', 'no_face', 20 * S, 0.9),
        anomaly('a3', 'no_face', 40 * S, 0.7),
      ],
      DEFAULT_POLICY,
    );
    expect(rest).toHaveLength(0);
    expect(v).toMatchObject({
      id: 'a1',
      type: 'no_face',
      category: 'video',
      severity: 'medium',
      count: 3,
      firstTs: 0,
      lastTs: 40 * S,
      confidence: 0.9,
      anomalyIds: ['a1', 'a2', 'a3'],
    });
    expect(v?.evidence.map((e) => e.id)).toEqual(['e-a1', 'e-a2', 'e-a3']);
  });

  it('anchors the window at the first anomaly instead of chaining', () => {
    const out = mergeViolations(
      [
        anomaly('a', 'copy_paste', 0),
        anomaly('b', 'copy_paste', 50 * S),
        anomaly('c', 'copy_paste', 100 * S),
      ],
      DEFAULT_POLICY,
    );
    expect(out.map((v) => [v.firstTs, v.lastTs, v.count])).toEqual([
      [0, 50 * S, 2],
      [100 * S, 100 * S, 1],
    ]);
  });

  it('includes an anomaly exactly at the window edge', () => {
    const out = mergeViolations(
      [anomaly('a', 'copy_paste', 0), anomaly('b', 'copy_paste', 60 * S)],
      DEFAULT_POLICY,
    );
    expect(out).toHaveLength(1);
  });

  it('uses the policy merge window', () => {
    const policy = parsePolicy({
      ...DEFAULT_POLICY,
      merge: { ...DEFAULT_POLICY.merge, windowSeconds: 10 },
    });
    const out = mergeViolations(
      [anomaly('a', 'copy_paste', 0), anomaly('b', 'copy_paste', 11 * S)],
      policy,
    );
    expect(out).toHaveLength(2);
  });

  it('never merges different types', () => {
    const out = mergeViolations(
      [anomaly('a', 'copy_paste', 0), anomaly('b', 'refresh_attempt', 1 * S)],
      DEFAULT_POLICY,
    );
    expect(out.map((v) => v.type)).toEqual(['copy_paste', 'refresh_attempt']);
  });

  it('is independent of input order (sorted by time, ties by id)', () => {
    const input = [
      anomaly('z', 'phone_detected', 5 * S),
      anomaly('b', 'no_face', 0),
      anomaly('a', 'speech_detected', 0),
      anomaly('y', 'no_face', 3 * S),
    ];
    const forward = mergeViolations(input, DEFAULT_POLICY);
    const backward = mergeViolations([...input].reverse(), DEFAULT_POLICY);
    expect(backward).toEqual(forward);
    expect(forward.map((v) => v.id)).toEqual(['a', 'b', 'z']);
  });

  it('counts a retried (duplicate id) anomaly once', () => {
    const a = anomaly('same', 'fullscreen_exit', 0);
    const out = mergeViolations([a, a, { ...a }], DEFAULT_POLICY);
    expect(out).toHaveLength(1);
    expect(out[0]?.count).toBe(1);
  });

  it('dedupes shared evidence across merged anomalies', () => {
    const shared = { id: 'frame-1', kind: 'frame', ts: 0 } as const;
    const out = mergeViolations(
      [
        { ...anomaly('a', 'no_face', 0), evidence: [shared] },
        { ...anomaly('b', 'no_face', S), evidence: [shared, { ...shared, id: 'frame-2' }] },
      ],
      DEFAULT_POLICY,
    );
    expect(out[0]?.evidence.map((e) => e.id)).toEqual(['frame-1', 'frame-2']);
  });

  it('takes severity from the policy', () => {
    const policy = parsePolicy({
      ...DEFAULT_POLICY,
      severityByType: { ...DEFAULT_POLICY.severityByType, copy_paste: 'high' },
    });
    expect(mergeViolations([anomaly('a', 'copy_paste', 0)], policy)[0]?.severity).toBe('high');
  });

  it('produces violations that always link to evidence and pass the schema', () => {
    const out = mergeViolations(
      [anomaly('a', 'multiple_voices', 0, 0.4), anomaly('b', 'inactivity', 9 * S)],
      DEFAULT_POLICY,
    );
    for (const v of out) {
      expect(v.evidence.length).toBeGreaterThan(0);
      expect(() => ViolationSchema.parse(v)).not.toThrow();
    }
  });

  it('rejects anomalies without evidence', () => {
    const bare = { ...anomaly('a', 'no_face', 0), evidence: [] };
    expect(() => mergeViolations([bare], DEFAULT_POLICY)).toThrow();
  });

  it('rejects out-of-range confidence and invalid policies', () => {
    expect(() => mergeViolations([anomaly('a', 'no_face', 0, 1.5)], DEFAULT_POLICY)).toThrow();
    const bad = { ...DEFAULT_POLICY, merge: { windowSeconds: 0, countMultipliesPoints: false } };
    expect(() => mergeViolations([], bad)).toThrow();
  });

  it('merges a keyboard refresh (key press + completed reload) into one violation, count 2', () => {
    let state = createRuleEngineState(0);
    const detected = [];
    for (const event of [
      { kind: 'refresh_key', ts: 1 * S },
      { kind: 'page_reload', ts: 2 * S },
    ] as const) {
      const step = stepRuleEngine(state, event, DEFAULT_POLICY);
      state = step.state;
      detected.push(...step.anomalies);
    }
    const out = mergeViolations(
      detected.map((d, i) => ({
        ...d,
        id: `r${String(i)}`,
        evidence: [{ id: `e${String(i)}`, kind: 'event_sequence', ts: d.ts }],
      })),
      DEFAULT_POLICY,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'refresh_attempt', count: 2 });
  });

  it('returns nothing for no anomalies', () => {
    expect(mergeViolations([], DEFAULT_POLICY)).toEqual([]);
  });
});
