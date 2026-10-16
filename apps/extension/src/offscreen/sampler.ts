import {
  analyzeFrame,
  createFaceMatchState,
  createGazeState,
  planSampling,
  sampleFrameTimes,
  singleFaceScore,
  stepFaceMatch,
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
//
// Optional face matching (Phase 11): only when `embed` is given (policy.faceMatch.enabled and
// the candidate opted in). Right after start, extra frames build an in-memory reference of the
// candidate's face; every sampled frame is then compared with it. Embeddings never leave this
// class. The frame that completed the reference is held in memory and stored only as evidence
// next to a face_mismatch, so the reviewer can compare the faces themselves.

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
  /** Face-matching progress; absent when face matching is off for the session. */
  faceMatch?: 'enrolling' | 'enrolled';
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
  /**
   * Face embedding of the frame's single face (after `analyze`), or undefined when the face
   * could not be aligned. Present only when face matching is on for this session.
   */
  embed?(frame: F): Promise<Float32Array | undefined>;
  /**
   * Encodes and stores a frame as evidence. Only ever called for anomalous frames, bursts, and
   * the face-matching reference frame next to a face_mismatch.
   */
  persist(frame: F): Promise<EvidenceRef>;
  report(anomalies: PendingAnomaly[]): void;
  reportMeta(meta: VideoMeta): void;
  log?(message: string, error?: unknown): void;
}

export class VideoSampler<F extends CapturedFrame> {
  private gaze = createGazeState();
  private faceMatch = createFaceMatchState();
  /** The frame that completed the face-matching reference (in memory only). */
  private reference: F | undefined;
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
    if (this.deps.embed) {
      this.scheduleEnrolment(this.deps.now() + this.deps.policy.faceMatch.enrolMaxSeconds * 1000);
    }
    this.scheduleWindow(Math.floor(this.deps.now()));
  }

  stop(): void {
    this.stopped = true;
    for (const id of this.timers) this.deps.clearTimeout(id);
    this.timers.clear();
    // Queued frame work may still use the reference; release it once that has finished.
    void this.queue.then(() => {
      this.reference?.close();
      this.reference = undefined;
    });
  }

  /** Resolves when all queued frame work has finished (tests, shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  /**
   * Captures a burst of capture.burstFrames frames now (FR6), for an anomaly raised elsewhere
   * (browser or audio). Frames are stored as evidence without analysis.
   */
  captureBurst(): Promise<EvidenceRef[]> {
    return this.stopped ? Promise.resolve([]) : this.burst();
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
      ...(this.deps.embed ? { faceMatch: this.faceMatch.phase } : {}),
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
      const analysis = analyzeFrame(observation, this.deps.policy);
      // The budget judges the detection models only. Face matching adds at most one embedding
      // per frame (docs/PERFORMANCE.md); counting it would cut the sampling rate of every
      // face-matching session, even on fast devices.
      this.recordInference(inferenceMs);
      const match = await this.matchFace(frame, observation);
      const gaze = stepGaze(this.gaze, observation.ts, analysis.gaze, this.deps.policy);
      this.gaze = gaze.state;
      if (match.enrolled) kept = this.keepReference(frame);
      const anomalies: DetectedAnomaly[] = [
        ...analysis.anomalies,
        ...(gaze.anomaly ? [gaze.anomaly] : []),
        ...(match.anomaly ? [match.anomaly] : []),
      ];
      if (anomalies.length === 0) return; // discarded in `finally`, never persisted

      const reference =
        match.anomaly && this.reference ? [await this.deps.persist(this.reference)] : [];
      const evidence = [await this.deps.persist(frame)];
      if (!kept) frame.close();
      kept = true; // closed or held as the reference; `finally` must not close it
      evidence.push(...(await this.burst()));
      this.deps.report(
        anomalies.map((a) => ({
          ...a,
          evidence: a.type === 'face_mismatch' ? [...reference, ...evidence] : evidence,
        })),
      );
    } finally {
      if (!kept) frame.close();
    }
  }

  /** Extra frames right after start that build the face-matching reference. */
  private scheduleEnrolment(deadline: number): void {
    this.enqueue(async () => {
      await this.enrolOne();
      const interval = this.deps.policy.faceMatch.enrolIntervalMs;
      if (this.faceMatch.phase === 'enrolling' && this.deps.now() + interval <= deadline) {
        this.later(interval, () => {
          this.scheduleEnrolment(deadline);
        });
      }
    });
  }

  private async enrolOne(): Promise<void> {
    if (this.faceMatch.phase !== 'enrolling') return;
    const frame = await this.deps.grab();
    if (!frame) return;
    let kept = false;
    try {
      const { observation } = await this.deps.analyze(frame);
      if ((await this.matchFace(frame, observation)).enrolled) kept = this.keepReference(frame);
    } finally {
      if (!kept) frame.close();
    }
  }

  private keepReference(frame: F): true {
    this.reference?.close();
    this.reference = frame;
    return true;
  }

  /** Feeds one frame to the face-matching rule (a no-op when face matching is off). */
  private async matchFace(
    frame: F,
    observation: FrameObservation,
  ): Promise<{ enrolled?: boolean; anomaly?: DetectedAnomaly }> {
    const { deps } = this;
    const { policy } = deps;
    if (!deps.embed) return {};
    const single = singleFaceScore(observation.faceScores, policy) !== undefined;
    const embedding = single ? await deps.embed(frame) : undefined;
    const step = stepFaceMatch(this.faceMatch, observation.ts, embedding, policy);
    this.faceMatch = step.state;
    if (step.enrolled) this.deps.reportMeta(this.meta());
    return {
      ...(step.enrolled ? { enrolled: true } : {}),
      ...(step.anomaly ? { anomaly: step.anomaly } : {}),
    };
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
