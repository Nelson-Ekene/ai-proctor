import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, PolicySchema, parsePolicy, type Policy } from './policy';

/** Mutable deep copy of the default policy as a plain JSON tree. */
function draft(): Record<string, Record<string, unknown>> {
  return JSON.parse(JSON.stringify(DEFAULT_POLICY)) as Record<string, Record<string, unknown>>;
}

function patched(section: string, key: string, value: unknown): unknown {
  const p = draft();
  const s = p[section];
  if (!s) throw new Error(`no section ${section}`);
  s[key] = value;
  return p;
}

describe('DEFAULT_POLICY', () => {
  it('is valid', () => {
    expect(() => parsePolicy(DEFAULT_POLICY)).not.toThrow();
  });

  it('matches the PRD defaults', () => {
    expect(DEFAULT_POLICY.weights).toEqual({ browser: 0.4, video: 0.4, audio: 0.2 });
    expect(DEFAULT_POLICY.severityPoints).toEqual({ low: 5, medium: 15, high: 30 });
    expect(DEFAULT_POLICY.bands).toEqual({ lowMax: 29, mediumMax: 59 });
    expect(DEFAULT_POLICY.sampling).toEqual({ framesPerWindow: 5, windowSeconds: 30 });
    expect(DEFAULT_POLICY.audio).toEqual({ bufferSeconds: 10, maxClipSeconds: 30 });
    expect(DEFAULT_POLICY.capture).toMatchObject({
      eventsBeforeSeconds: 30,
      eventsAfterSeconds: 15,
      burstFrames: 3,
    });
    expect(DEFAULT_POLICY.merge.countMultipliesPoints).toBe(false);
  });

  it('is deeply frozen so nobody can mutate the defaults', () => {
    expect(Object.isFrozen(DEFAULT_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_POLICY.weights)).toBe(true);
    expect(Object.isFrozen(DEFAULT_POLICY.severityByType)).toBe(true);
  });

  it('parses into a fresh, mutable copy (snapshots are independent)', () => {
    const copy: Policy = parsePolicy(DEFAULT_POLICY);
    expect(copy).toEqual(DEFAULT_POLICY);
    expect(copy).not.toBe(DEFAULT_POLICY);
    expect(copy.weights).not.toBe(DEFAULT_POLICY.weights);
  });
});

describe('policy validation', () => {
  it('rejects weights that do not sum to 1', () => {
    expect(() => parsePolicy(patched('weights', 'audio', 0.3))).toThrow(/weights must sum to 1/);
  });

  it('accepts float-noisy weights and a zero weight', () => {
    expect(() => parsePolicy(patched('weights', 'browser', 0.1 + 0.2 + 0.1 - 1e-12))).not.toThrow();
    const p = draft();
    p.weights = { browser: 0.5, video: 0.5, audio: 0 };
    expect(() => parsePolicy(p)).not.toThrow();
  });

  it('rejects a weight outside [0, 1]', () => {
    const p = draft();
    p.weights = { browser: 1.2, video: -0.2, audio: 0 };
    expect(PolicySchema.safeParse(p).success).toBe(false);
  });

  it.each([
    ['lowMax >= mediumMax', { lowMax: 59, mediumMax: 59 }],
    ['lowMax > mediumMax', { lowMax: 60, mediumMax: 30 }],
    ['mediumMax >= 100', { lowMax: 29, mediumMax: 100 }],
  ])('rejects unordered bands (%s)', (_label, bands) => {
    const p = draft();
    p.bands = bands;
    expect(() => parsePolicy(p)).toThrow(/bands must satisfy/);
  });

  it.each([
    ['severityPoints', 'low'],
    ['severityPoints', 'high'],
    ['bands', 'lowMax'],
    ['sampling', 'windowSeconds'],
    ['sampling', 'framesPerWindow'],
    ['audio', 'bufferSeconds'],
    ['capture', 'eventsBeforeSeconds'],
    ['capture', 'logRetentionSeconds'],
    ['merge', 'windowSeconds'],
    ['inactivity', 'seconds'],
    ['gazeAway', 'sustainedSeconds'],
  ])('rejects zero or negative %s.%s', (section, key) => {
    expect(PolicySchema.safeParse(patched(section, key, 0)).success).toBe(false);
    expect(PolicySchema.safeParse(patched(section, key, -1)).success).toBe(false);
  });

  it('rejects zero/fractional retentionDays and fractional frame counts', () => {
    const p = draft() as Record<string, unknown>;
    p.retentionDays = 0;
    expect(PolicySchema.safeParse(p).success).toBe(false);
    p.retentionDays = 1.5;
    expect(PolicySchema.safeParse(p).success).toBe(false);
    expect(PolicySchema.safeParse(patched('sampling', 'framesPerWindow', 2.5)).success).toBe(false);
    expect(PolicySchema.safeParse(patched('capture', 'burstFrames', 1.5)).success).toBe(false);
  });

  it('requires the activity ping to be shorter than the inactivity threshold', () => {
    expect(() => parsePolicy(patched('inactivity', 'pingSeconds', 60))).toThrow(/pingSeconds/);
    expect(PolicySchema.safeParse(patched('inactivity', 'pingSeconds', 0)).success).toBe(false);
  });

  it('rejects sampling slots narrower than 1 ms', () => {
    const p = draft();
    p.sampling = { framesPerWindow: 10, windowSeconds: 0.005 };
    expect(() => parsePolicy(p)).toThrow(/at least 1 ms/);
  });

  it('validates the setup-check section', () => {
    expect(PolicySchema.safeParse(patched('setupCheck', 'micLevelMin', 1.5)).success).toBe(false);
    expect(PolicySchema.safeParse(patched('setupCheck', 'faceFrameRatioMin', -0.1)).success).toBe(
      false,
    );
    expect(PolicySchema.safeParse(patched('setupCheck', 'inferenceBudgetMs', 0)).success).toBe(
      false,
    );
    expect(PolicySchema.safeParse(patched('setupCheck', 'sampleSeconds', 0)).success).toBe(false);
    expect(PolicySchema.safeParse(patched('setupCheck', 'measureIntervalMs', 0)).success).toBe(
      false,
    );
    expect(PolicySchema.safeParse(patched('setupCheck', 'faceMinConfidence', 1.2)).success).toBe(
      false,
    );
    const { setupCheck } = DEFAULT_POLICY;
    expect(setupCheck).toEqual({
      sampleSeconds: 3,
      measureIntervalMs: 200,
      faceMinConfidence: 0.5,
      micLevelMin: 0.02,
      faceFrameRatioMin: 0.5,
      inferenceBudgetMs: 200,
    });
  });

  it('allows burstFrames = 0 (burst disabled)', () => {
    expect(PolicySchema.safeParse(patched('capture', 'burstFrames', 0)).success).toBe(true);
  });

  it('requires a severity for every violation type', () => {
    const p = draft();
    const severities = p.severityByType as Record<string, unknown>;
    delete severities.phone_detected;
    expect(PolicySchema.safeParse(p).success).toBe(false);
  });

  it('rejects unknown severities and unknown keys', () => {
    expect(PolicySchema.safeParse(patched('severityByType', 'no_face', 'critical')).success).toBe(
      false,
    );
    expect(PolicySchema.safeParse(patched('weights', 'screen', 0)).success).toBe(false);
  });

  it('rejects an audio buffer longer than the clip cap', () => {
    expect(() => parsePolicy(patched('audio', 'bufferSeconds', 31))).toThrow(/bufferSeconds/);
  });

  it('rejects a log retention shorter than the capture window', () => {
    expect(() => parsePolicy(patched('capture', 'logRetentionSeconds', 44))).toThrow(
      /logRetentionSeconds/,
    );
  });
});
