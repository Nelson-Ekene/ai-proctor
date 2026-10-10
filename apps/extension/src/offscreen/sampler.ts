import {
  analyzeFrame,
  createGazeState,
  planSampling,
  sampleFrameTimes,
  stepGaze,
  withFramesPerWindow,
  type DetectedAnomaly,
  type EvidenceRef,
  type FrameObservation,
  type PendingAnomaly,
  type Policy,
  type Rng,
  type SamplingPlan,
} from '@proctor/core';

// Webcam sampler (FR1, FR2, FR6): 5 random frames per 30 s window (policy), each analysed on
// the device. A frame with no finding is closed and dropped: it is never encoded, stored or
// uploaded. A frame with a finding is kept as evidence together with a burst of extra frames.

export interface CapturedFrame {
  /** Capture time, epoch ms. */
  readonly ts: number;
  /** Releases the pixels. Called exactly once for every grabbed frame. */
  close(): void;
}

export interface VideoMeta {
  degraded: boolean;
  framesPerWindow: number;
  medianInferenceMs?: number;
}

export interface SamplerDeps<F extends CapturedFrame> {
  policy: Policy;
  now(): number;
  rng: Rng;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  /** Grabs the current camera frame, or undefined if the camera has no frame yet. */
  grab(): Promise<F | undefined>;
  analyze(frame: F): Promise<{ observation: FrameObservation; inferenceMs: number }>;
  /** Encodes and stores a frame as evidence. Only ever called for anomalous frames + bursts. */
  persist(frame: F): Promise<EvidenceRef>;
  report(anomalies: PendingAnomaly[]): void;
  reportMeta(meta: VideoMeta): void;
  log?(message: string, error?: unknown): void;
}

export class VideoSampler<F extends CapturedFrame> {
  private gaze = createGazeState();
  private inference: number[] = [];
  private plan: SamplingPlan;
  private readonly timers = new Set<unknown>();
  private queue: Promise<void> = Promise.resolve();
  private stopped = true;

  constructor(private readonly deps: SamplerDeps<F>) {
    this.plan = planSampling([], deps.policy);
  }

  get framesPerWindow(): number {
    return this.plan.framesPerWindow;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.deps.reportMeta(this.meta());
    this.scheduleWindow(Math.floor(this.deps.now()));
  }

  stop(): void {
    this.stopped = true;
    for (const id of this.timers) this.deps.clearTimeout(id);
    this.timers.clear();
  }

  /** Resolves when all queued frame work has finished (tests, shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  private later(ms: number, fn: () => void): void {
    const id = this.deps.setTimeout(
      () => {
        this.timers.delete(id);
        if (!this.stopped) fn();
      },
      Math.max(0, ms),
    );
    this.timers.add(id);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.deps.setTimeout(resolve, ms));
  }

  private scheduleWindow(windowStart: number): void {
    const policy = withFramesPerWindow(this.deps.policy, this.plan.framesPerWindow);
    const now = this.deps.now();
    for (const t of sampleFrameTimes(windowStart, policy, this.deps.rng)) {
      this.later(t - now, () => {
        this.enqueue(() => this.sampleOne());
      });
    }
    const next = windowStart + this.deps.policy.sampling.windowSeconds * 1000;
    this.later(next - now, () => {
      this.scheduleWindow(next);
    });
  }

  /** Frames are processed one at a time so inference never overlaps. */
  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue
      .then(task)
      .catch((error: unknown) => this.deps.log?.('frame failed', error));
  }

  private meta(): VideoMeta {
    return {
      degraded: this.plan.degraded,
      framesPerWindow: this.plan.framesPerWindow,
      ...(this.plan.medianInferenceMs === undefined
        ? {}
        : { medianInferenceMs: this.plan.medianInferenceMs }),
    };
  }

  private recordInference(ms: number): void {
    // Judge the device on its most recent window's worth of frames.
    this.inference = [...this.inference, ms].slice(-this.deps.policy.sampling.framesPerWindow);
    const next = planSampling(this.inference, this.deps.policy);
    // Degrading is sticky for the session so the rate does not flap.
    if (next.degraded && !this.plan.degraded) {
      this.plan = next;
      this.deps.reportMeta(this.meta());
    } else if (!this.plan.degraded) {
      this.plan = next;
    }
  }

  private async sampleOne(): Promise<void> {
    const frame = await this.deps.grab();
    if (!frame) return;
    let kept = false;
    try {
      const { observation, inferenceMs } = await this.deps.analyze(frame);
      this.recordInference(inferenceMs);
      const analysis = analyzeFrame(observation, this.deps.policy);
      const gaze = stepGaze(this.gaze, observation.ts, analysis.gaze, this.deps.policy);
      this.gaze = gaze.state;
      const anomalies: DetectedAnomaly[] = [
        ...analysis.anomalies,
        ...(gaze.anomaly ? [gaze.anomaly] : []),
      ];
      if (anomalies.length === 0) return; // discarded in `finally`, never persisted

      const evidence = [await this.deps.persist(frame)];
      frame.close();
      kept = true; // already closed; `finally` must not close it again
      evidence.push(...(await this.burst()));
      this.deps.report(anomalies.map((a) => ({ ...a, evidence })));
    } finally {
      if (!kept) frame.close();
    }
  }

  /** Extra frames right after an anomalous one (capture.burstFrames). Not analysed. */
  private async burst(): Promise<EvidenceRef[]> {
    const refs: EvidenceRef[] = [];
    for (let i = 0; i < this.deps.policy.capture.burstFrames; i++) {
      await this.delay(this.deps.policy.video.burstIntervalMs);
      if (this.stopped) break;
      const frame = await this.deps.grab();
      if (!frame) continue;
      try {
        refs.push(await this.deps.persist(frame));
      } finally {
        frame.close();
      }
    }
    return refs;
  }
}
