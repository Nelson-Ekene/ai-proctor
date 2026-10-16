import {
  DEFAULT_POLICY,
  parsePolicy,
  type EvidenceRef,
  type FrameObservation,
  type PendingAnomaly,
  type Policy,
} from '@proctor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoSampler, type CapturedFrame, type VideoMeta } from './sampler';

const T0 = 1_700_000_000_000;

interface FakeFrame extends CapturedFrame {
  id: number;
  closed: number;
}

type Scene = Partial<Omit<FrameObservation, 'ts'>>;
const FACE: Scene = {
  faceScores: [0.95],
  objects: [],
  headPose: { yawDegrees: 0, pitchDegrees: 0 },
};

function harness(
  opts: {
    policy?: Policy;
    scene?: (ts: number) => Scene;
    inferenceMs?: number;
    /** Face matching on, with this (2-number) embedding per frame time. */
    embedding?: (ts: number) => number[] | undefined;
  } = {},
) {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const frames: FakeFrame[] = [];
  const persisted: number[] = [];
  const analyzed: number[] = [];
  const embedded: number[] = [];
  const reports: PendingAnomaly[][] = [];
  const metas: VideoMeta[] = [];
  let seq = 0;
  const { embedding } = opts;
  const sampler = new VideoSampler<FakeFrame>({
    ...(embedding
      ? {
          embed: (frame: FakeFrame) => {
            embedded.push(frame.id);
            const e = embedding(frame.ts);
            return Promise.resolve(e ? Float32Array.from(e) : undefined);
          },
        }
      : {}),
    policy,
    now: () => Date.now(),
    rng: () => 0.5,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => {
      clearTimeout(id as ReturnType<typeof setTimeout>);
    },
    grab: () => {
      const frame: FakeFrame = {
        id: ++seq,
        ts: Date.now(),
        closed: 0,
        close() {
          this.closed += 1;
        },
      };
      frames.push(frame);
      return Promise.resolve(frame);
    },
    analyze: (frame) => {
      analyzed.push(frame.id);
      const scene = { ...FACE, ...(opts.scene?.(frame.ts) ?? {}) };
      return Promise.resolve({
        observation: { ts: frame.ts, faceScores: [], objects: [], ...scene },
        inferenceMs: opts.inferenceMs ?? 20,
      });
    },
    persist: (frame): Promise<EvidenceRef> => {
      persisted.push(frame.id);
      return Promise.resolve({ id: `f${String(frame.id)}`, kind: 'frame', ts: frame.ts });
    },
    report: (a) => reports.push(a),
    reportMeta: (m) => metas.push(m),
  });
  return { sampler, frames, persisted, analyzed, embedded, reports, metas };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('VideoSampler scheduling', () => {
  it('samples framesPerWindow frames per window, one per slot, window after window', async () => {
    const h = harness();
    h.sampler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.analyzed).toHaveLength(5);
    // rng 0.5 -> middle of each 6 s slot
    expect(h.frames.map((f) => f.ts - T0)).toEqual([3000, 9000, 15000, 21000, 27000]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.analyzed).toHaveLength(10);
    h.sampler.stop();
  });

  it('stops scheduling on stop and starts only once', async () => {
    const h = harness();
    h.sampler.start();
    h.sampler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    h.sampler.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.analyzed).toHaveLength(2);
    expect(h.metas).toEqual([{ degraded: false, framesPerWindow: 5 }]);
  });

  it('skips a slot when the camera has no frame yet', async () => {
    const h = harness();
    const deps = (h.sampler as unknown as { deps: { grab: () => Promise<unknown> } }).deps;
    deps.grab = () => Promise.resolve(undefined);
    h.sampler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.analyzed).toEqual([]);
    h.sampler.stop();
  });
});

describe('VideoSampler privacy: only anomalous frames are kept', () => {
  it('analyses and discards every normal frame without persisting it', async () => {
    const h = harness();
    h.sampler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    h.sampler.stop();
    await h.sampler.idle();
    expect(h.analyzed).toHaveLength(10);
    expect(h.persisted).toEqual([]);
    expect(h.reports).toEqual([]);
    expect(h.frames.every((f) => f.closed === 1)).toBe(true);
  });

  it('keeps an anomalous frame plus a burst of extra frames, all linked as evidence', async () => {
    const h = harness({ scene: () => ({ objects: [{ category: 'cell phone', score: 0.9 }] }) });
    h.sampler.start();
    await vi.advanceTimersByTimeAsync(3000); // first frame
    await vi.advanceTimersByTimeAsync(3 * 1000); // burst of 3 at 1 s spacing
    h.sampler.stop();
    await h.sampler.idle();
    expect(h.analyzed).toEqual([1]); // burst frames are not analysed
    expect(h.persisted).toEqual([1, 2, 3, 4]);
    expect(h.reports).toHaveLength(1);
    const [report] = h.reports;
    expect(report?.map((a) => a.type)).toEqual(['phone_detected']);
    expect(report?.[0]?.evidence?.map((e) => e.id)).toEqual(['f1', 'f2', 'f3', 'f4']);
    expect(report?.[0]?.confidence).toBe(0.9);
    expect(h.frames.every((f) => f.closed === 1)).toBe(true);
  });

  it('honours capture.burstFrames = 0', async () => {
    const policy = parsePolicy({
      ...DEFAULT_POLICY,
      capture: { ...DEFAULT_POLICY.capture, burstFrames: 0 },
    });
    const h = harness({ policy, scene: () => ({ faceScores: [] }) });
    h.sampler.start();
    await vi.advanceTimersByTimeAsync(3000);
    await h.sampler.idle();
    expect(h.persisted).toEqual([1]);
    expect(h.reports[0]?.[0]).toMatchObject({ type: 'no_face', confidence: 1 });
    h.sampler.stop();
  });

  it('closes frames even when analysis or storage fails', async () => {
    const h = harness({ scene: () => ({ faceScores: [] }) });
    const deps = (h.sampler as unknown as { deps: { persist: () => Promise<EvidenceRef> } }).deps;
    deps.persist = () => Promise.reject(new Error('disk full'));
    h.sampler.start();
    await vi.advanceTimersByTimeAsync(3000);
    await h.sampler.idle();
    expect(h.reports).toEqual([]);
    expect(h.frames[0]?.closed).toBe(1);

    const h2 = harness();
    const deps2 = (h2.sampler as unknown as { deps: { analyze: () => Promise<never> } }).deps;
    deps2.analyze = () => Promise.reject(new Error('model crashed'));
    h2.sampler.start();
    await vi.advanceTimersByTimeAsync(3000);
    await h2.sampler.idle();
    expect(h2.frames[0]?.closed).toBe(1);
    expect(h2.persisted).toEqual([]);
    h.sampler.stop();
    h2.sampler.stop();
  });

  it('stops a burst early when the sampler is stopped', async () => {
    const h = harness({ scene: () => ({ faceScores: [] }) });
    h.sampler.start();
    await vi.advanceTimersByTimeAsync(3000);
    h.sampler.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await h.sampler.idle();
    expect(h.persisted).toEqual([1]);
    expect(h.reports).toHaveLength(1);
  });
});

describe('VideoSampler on-demand burst (phase 6)', () => {
  it('captures a burst of unanalysed frames for an anomaly raised elsewhere', async () => {
    const h = harness();
    h.sampler.start();
    const burst = h.sampler.captureBurst();
    await vi.advanceTimersByTimeAsync(3 * 1000);
    const evidence = await burst;
    expect(evidence.map((e) => e.kind)).toEqual(['frame', 'frame', 'frame']);
    // Burst frames are evidence only, never analysed (the regular 3 s sample may be).
    const burstIds = evidence.map((e) => Number(e.id.slice(1)));
    expect(h.analyzed.filter((id) => burstIds.includes(id))).toEqual([]);
    expect(h.frames.every((f) => f.closed === 1)).toBe(true);
    h.sampler.stop();
  });

  it('returns nothing once stopped', async () => {
    const h = harness();
    expect(await h.sampler.captureBurst()).toEqual([]);
  });
});

describe('VideoSampler gaze and degradation', () => {
  it('raises sustained gaze-away only across consecutive away frames', async () => {
    const policy = parsePolicy({
      ...DEFAULT_POLICY,
      capture: { ...DEFAULT_POLICY.capture, burstFrames: 0 },
    });
    const h = harness({ policy, scene: () => ({ headPose: { yawDegrees: 50, pitchDegrees: 0 } }) });
    h.sampler.start();
    await vi.advanceTimersByTimeAsync(3000); // first away frame: run starts
    await h.sampler.idle();
    expect(h.reports).toEqual([]);
    await vi.advanceTimersByTimeAsync(6000); // second away frame 6 s later >= 5 s
    await h.sampler.idle();
    expect(h.reports.map((r) => r.map((a) => a.type))).toEqual([['gaze_away_sustained']]);
    h.sampler.stop();
  });

  it('judges the inference budget on the detection models only, with face matching on', async () => {
    const h = harness({ inferenceMs: 230, embedding: () => [1, 0] }); // under the 250 ms budget
    h.sampler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.embedded.length).toBeGreaterThan(0);
    expect(h.metas.every((m) => !m.degraded)).toBe(true);
    h.sampler.stop();
  });

  it('drops to the degraded rate once inference is over budget, and stays there', async () => {
    const h = harness({ inferenceMs: 400 });
    h.sampler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.metas.at(-1)).toEqual({ degraded: true, framesPerWindow: 3, medianInferenceMs: 400 });
    expect(h.sampler.framesPerWindow).toBe(3);
    const before = h.analyzed.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.analyzed.length - before).toBe(3);
    h.sampler.stop();
  });
});

describe('VideoSampler face matching (phase 11)', () => {
  const SAME = [1, 0];
  const OTHER = [0.1, Math.sqrt(1 - 0.01)];
  const noBurst = parsePolicy({
    ...DEFAULT_POLICY,
    capture: { ...DEFAULT_POLICY.capture, burstFrames: 0 },
    faceMatch: { ...DEFAULT_POLICY.faceMatch, enabled: true },
  });

  it('is off without an embedder: no extra frames, no face-matching state', async () => {
    const h = harness();
    h.sampler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    h.sampler.stop();
    expect(h.frames).toHaveLength(5);
    expect(h.metas.every((m) => m.faceMatch === undefined)).toBe(true);
  });

  it('builds the reference from extra frames at start, storing none of them', async () => {
    const h = harness({ policy: noBurst, embedding: () => SAME });
    h.sampler.start();
    expect(h.metas).toEqual([{ degraded: false, framesPerWindow: 5, faceMatch: 'enrolling' }]);
    await vi.advanceTimersByTimeAsync(4000); // enrolment frames at 0, 1, 2, 3, 4 s
    await h.sampler.idle();
    expect(h.metas.at(-1)?.faceMatch).toBe('enrolled');
    // Five enrolment frames plus the regular 3 s sample, which also counted.
    const enrolFrames = h.frames.filter((f) => (f.ts - T0) % 1000 === 0);
    expect(enrolFrames.length).toBeGreaterThanOrEqual(4);
    expect(h.persisted).toEqual([]);
    expect(h.reports).toEqual([]);
    // Every frame is released except the one that completed the reference.
    expect(h.frames.filter((f) => f.closed === 0)).toHaveLength(1);
    const grabbed = h.frames.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.frames.length - grabbed).toBe(1); // only the 9 s sample: enrolment has finished
    h.sampler.stop();
    await h.sampler.idle();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.frames.every((f) => f.closed === 1)).toBe(true);
  });

  it('raises face_mismatch after consecutive different faces, with the reference frame as evidence', async () => {
    const h = harness({ policy: noBurst, embedding: (ts) => (ts - T0 < 10_000 ? SAME : OTHER) });
    h.sampler.start();
    await vi.advanceTimersByTimeAsync(30_000); // samples at 15, 21, 27 s show another face
    await h.sampler.idle();
    expect(h.reports).toHaveLength(1);
    const [anomaly] = h.reports[0] ?? [];
    expect(anomaly).toMatchObject({ type: 'face_mismatch', ts: T0 + 27_000 });
    expect(anomaly?.confidence).toBeCloseTo(0.9);
    const referenceId = h.frames.find((f) => f.closed === 0)?.id;
    const flaggedId = h.frames.find((f) => f.ts === T0 + 27_000)?.id;
    expect(anomaly?.evidence?.map((e) => e.id)).toEqual([
      `f${String(referenceId)}`,
      `f${String(flaggedId)}`,
    ]);
    // The other different-face frames were not stored.
    expect(h.persisted).toEqual([referenceId, flaggedId]);
    h.sampler.stop();
  });

  it('keeps the reference frame and other anomalies apart', async () => {
    const policy = parsePolicy({
      ...noBurst,
      faceMatch: { ...noBurst.faceMatch, consecutiveSamples: 1 },
    });
    const h = harness({
      policy,
      embedding: (ts) => (ts - T0 < 10_000 ? SAME : OTHER),
      scene: (ts) =>
        ts - T0 > 10_000 ? { objects: [{ category: 'cell phone', score: 0.9 }] } : {},
    });
    h.sampler.start();
    await vi.advanceTimersByTimeAsync(15_000);
    await h.sampler.idle();
    const report = h.reports[0] ?? [];
    expect(report.map((a) => [a.type, a.evidence?.length])).toEqual([
      ['phone_detected', 1],
      ['face_mismatch', 2],
    ]);
    h.sampler.stop();
  });

  it('stores an anomalous frame that also completed the reference without closing it', async () => {
    const policy = parsePolicy({
      ...noBurst,
      faceMatch: { ...noBurst.faceMatch, enrolSamples: 1, enrolMaxSeconds: 0.001 },
    });
    // Only the enrolment frame at 0 s has no face; the 3 s sample both enrols and shows a phone.
    const h = harness({
      policy,
      embedding: () => SAME,
      scene: (ts) =>
        ts === T0 ? { faceScores: [] } : { objects: [{ category: 'cell phone', score: 0.9 }] },
    });
    h.sampler.start();
    await vi.advanceTimersByTimeAsync(3000);
    await h.sampler.idle();
    const sample = h.frames.find((f) => f.ts === T0 + 3000);
    expect(h.persisted).toContain(sample?.id);
    expect(sample?.closed).toBe(0); // held as the reference
    expect(h.metas.at(-1)?.faceMatch).toBe('enrolled');
    h.sampler.stop();
  });

  it('embeds only frames with exactly one confident face', async () => {
    const h = harness({
      policy: noBurst,
      embedding: () => SAME,
      scene: () => ({ faceScores: [0.9, 0.8] }),
    });
    h.sampler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await h.sampler.idle();
    expect(h.embedded).toEqual([]);
    expect(h.metas.at(-1)?.faceMatch).toBe('enrolling');
    h.sampler.stop();
  });

  it('stops taking extra reference frames after enrolMaxSeconds; regular samples carry on', async () => {
    const h = harness({ policy: noBurst, embedding: () => undefined }); // face never aligned
    h.sampler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    // Extra frames from 0 s to 30 s at 1 s spacing, plus the window's 5 regular samples.
    expect(h.frames).toHaveLength(31 + 5);
    const grabbed = h.frames.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.frames.length - grabbed).toBe(5);
    expect(h.frames.every((f) => f.closed === 1)).toBe(true);
    h.sampler.stop();
  });
});
