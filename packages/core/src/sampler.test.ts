import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, parsePolicy } from './policy';
import { sampleFrameTimes, type Rng } from './sampler';

function sequence(values: number[]): Rng {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i += 1;
    if (v === undefined) throw new Error('empty sequence');
    return v;
  };
}

/** Small deterministic PRNG (mulberry32) for property-style tests. */
function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertOnePerSlot(times: number[], start: number, slotMs: number, n: number): void {
  expect(times).toHaveLength(n);
  times.forEach((t, i) => {
    expect(Number.isInteger(t)).toBe(true);
    expect(t).toBeGreaterThanOrEqual(start + Math.round(i * slotMs));
    expect(t).toBeLessThan(start + Math.round((i + 1) * slotMs));
    if (i > 0) expect(t).toBeGreaterThan(times[i - 1] as number);
  });
}

describe('sampleFrameTimes', () => {
  const start = 1_700_000_000_000;

  it('returns exactly N strictly ordered times, one per 6 s slot (defaults)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      assertOnePerSlot(sampleFrameTimes(start, DEFAULT_POLICY, seeded(seed)), start, 6000, 5);
    }
  });

  it('maps rng 0 to the slot start and rng ~1 to just before the next slot', () => {
    expect(sampleFrameTimes(0, DEFAULT_POLICY, () => 0)).toEqual([0, 6000, 12000, 18000, 24000]);
    const late = sampleFrameTimes(0, DEFAULT_POLICY, () => 0.999999);
    assertOnePerSlot(late, 0, 6000, 5);
  });

  it('stays strictly ordered with non-integer slot widths and adversarial rng', () => {
    const policy = parsePolicy({
      ...DEFAULT_POLICY,
      sampling: { framesPerWindow: 7, windowSeconds: 30 },
    });
    const times = sampleFrameTimes(start, policy, sequence([0.9999999999, 0]));
    assertOnePerSlot(times, start, 30000 / 7, 7);
  });

  it('regression: a late pick never collides with the next slot start at epoch-ms scale', () => {
    const policy = parsePolicy({
      ...DEFAULT_POLICY,
      sampling: { framesPerWindow: 7, windowSeconds: 30 },
    });
    for (const r of [1 - Number.EPSILON, 0.9999999999, 0.99999]) {
      const times = sampleFrameTimes(start, policy, sequence([r, 0]));
      expect(new Set(times).size).toBe(7);
      assertOnePerSlot(times, start, 30000 / 7, 7);
    }
  });

  it('works when each slot is exactly 1 ms wide', () => {
    const policy = parsePolicy({
      ...DEFAULT_POLICY,
      sampling: { framesPerWindow: 5, windowSeconds: 0.005 },
    });
    expect(sampleFrameTimes(10, policy, () => 0.99)).toEqual([10, 11, 12, 13, 14]);
  });

  it.each([1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])(
    'rejects a non-integer windowStart (%s)',
    (bad) => {
      expect(() => sampleFrameTimes(bad, DEFAULT_POLICY, () => 0)).toThrow(RangeError);
    },
  );

  it('follows the policy, not a hard-coded rate', () => {
    const policy = parsePolicy({
      ...DEFAULT_POLICY,
      sampling: { framesPerWindow: 3, windowSeconds: 60 },
    });
    assertOnePerSlot(sampleFrameTimes(start, policy, seeded(7)), start, 20000, 3);
  });

  it('calls the rng exactly once per frame', () => {
    let calls = 0;
    sampleFrameTimes(0, DEFAULT_POLICY, () => {
      calls += 1;
      return 0.5;
    });
    expect(calls).toBe(5);
  });

  it.each([1, -0.1, Number.NaN, 2])('rejects an rng returning %s', (bad) => {
    expect(() => sampleFrameTimes(0, DEFAULT_POLICY, () => bad)).toThrow(RangeError);
  });
});
