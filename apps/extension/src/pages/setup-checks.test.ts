import { DEFAULT_POLICY, parsePolicy } from '@proctor/core';
import { describe, expect, it } from 'vitest';
import { evaluateSetup, median, rms, type SetupMeasurements } from './setup-checks';

const good: SetupMeasurements = {
  faceCounts: [1, 1, 1, 0],
  micLevels: [0.001, 0.05],
  inferenceMs: [20, 30, 25],
  modelLoaded: true,
};

describe('signal helpers', () => {
  it('computes RMS', () => {
    expect(rms([])).toBe(0);
    expect(rms([0.5, -0.5])).toBeCloseTo(0.5);
    expect(rms(new Float32Array([0, 0, 0, 0]))).toBe(0);
  });

  it('computes medians', () => {
    expect(median([])).toBeUndefined();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('evaluateSetup', () => {
  it('reports ready when every check is fine', () => {
    expect(evaluateSetup(good, DEFAULT_POLICY).result).toEqual({
      face: 'ready',
      mic: 'ready',
      performance: 'ready',
    });
  });

  it('flags a missing face, a silent mic and a slow device', () => {
    const e = evaluateSetup(
      { faceCounts: [0, 0, 1], micLevels: [0.001], inferenceMs: [500, 400], modelLoaded: true },
      DEFAULT_POLICY,
    );
    expect(e.result).toEqual({
      face: 'needs_attention',
      mic: 'needs_attention',
      performance: 'needs_attention',
    });
    expect(e.face.message).toMatch(/face/);
  });

  it('needs attention when the model did not load or nothing was measured', () => {
    const e = evaluateSetup(
      { faceCounts: [], micLevels: [], inferenceMs: [], modelLoaded: false },
      DEFAULT_POLICY,
    );
    expect(e.result).toEqual({
      face: 'needs_attention',
      mic: 'needs_attention',
      performance: 'needs_attention',
    });
    expect(evaluateSetup({ ...good, faceCounts: [] }, DEFAULT_POLICY).face.status).toBe(
      'needs_attention',
    );
  });

  it('uses policy thresholds', () => {
    const strict = parsePolicy({
      ...DEFAULT_POLICY,
      setupCheck: {
        sampleSeconds: 3,
        micLevelMin: 0.1,
        faceFrameRatioMin: 1,
        inferenceBudgetMs: 10,
      },
    });
    expect(evaluateSetup(good, strict).result).toEqual({
      face: 'needs_attention',
      mic: 'needs_attention',
      performance: 'needs_attention',
    });
  });

  it('uses only advisory wording', () => {
    const bad = evaluateSetup(
      { faceCounts: [], micLevels: [], inferenceMs: [], modelLoaded: false },
      DEFAULT_POLICY,
    );
    const messages = [bad, evaluateSetup(good, DEFAULT_POLICY)]
      .flatMap((e) => [e.face.message, e.mic.message, e.performance.message])
      .join(' ');
    expect(messages).not.toMatch(/\bpass|\bfail|block|disqualif/i);
  });
});
