import type { Policy } from './policy';
import type { DetectedAnomaly } from './schemas';

// On-device webcam analysis (FR2, BUILD_PLAN Phase 4): pure rules that turn raw model outputs
// for one sampled frame into findings. Face *detection* only: no recognition, no embeddings.
// Every finding carries the model's confidence; nothing below policy.video.minConfidence counts.

export interface Detection {
  /** Object-detector label (COCO), e.g. "person", "cell phone", "book". */
  category: string;
  score: number;
}

export interface HeadPose {
  /** Left/right rotation in degrees (0 = facing the camera). */
  yawDegrees: number;
  /** Up/down rotation in degrees (0 = level). */
  pitchDegrees: number;
}

/** Raw model outputs for one sampled frame. */
export interface FrameObservation {
  ts: number;
  /** Scores of every face the face detector returned (any score). */
  faceScores: number[];
  /** Object-detector results (any score). */
  objects: Detection[];
  /** Head pose of the most prominent face, if the landmarker found one. */
  headPose?: HeadPose;
}

export interface GazeSample {
  away: boolean;
  confidence: number;
}

export interface FrameAnalysis {
  /** Per-frame anomalies (no_face, multiple_faces, phone_detected, book_or_notes). */
  anomalies: DetectedAnomaly[];
  /** Input for the sustained-gaze tracker; undefined when no face was confidently seen. */
  gaze?: GazeSample;
}

export const OBJECT_LABELS = { person: 'person', phone: 'cell phone', book: 'book' } as const;

const desc = (a: number, b: number) => b - a;

function scoresOf(objects: readonly Detection[], label: string, min: number): number[] {
  return objects
    .filter((o) => o.category === label && o.score >= min)
    .map((o) => o.score)
    .sort(desc);
}

export function analyzeFrame(obs: FrameObservation, policy: Policy): FrameAnalysis {
  const min = policy.video.minConfidence;
  const { ts } = obs;
  const anomalies: DetectedAnomaly[] = [];
  const raise = (type: DetectedAnomaly['type'], confidence: number) => {
    if (confidence >= min) anomalies.push({ type, ts, confidence });
  };

  const faces = obs.faceScores.filter((s) => s >= min).sort(desc);
  const persons = scoresOf(obs.objects, OBJECT_LABELS.person, min);

  if (faces.length === 0) {
    // Confidence that no face is present: the complement of the best (sub-threshold) face score.
    raise('no_face', 1 - Math.max(0, ...obs.faceScores));
  }

  // Multiple faces, or an additional person the face detector may miss (e.g. turned away).
  // Confidence is the weakest detection needed for the claim: the second-highest score.
  const second = Math.max(faces[1] ?? 0, persons[1] ?? 0);
  if (second > 0) raise('multiple_faces', second);

  const phone = scoresOf(obs.objects, OBJECT_LABELS.phone, min)[0];
  if (phone !== undefined) raise('phone_detected', phone);
  const book = scoresOf(obs.objects, OBJECT_LABELS.book, min)[0];
  if (book !== undefined) raise('book_or_notes', book);

  const primary = faces[0];
  if (primary === undefined || !obs.headPose) return { anomalies };
  const { yawDegrees, pitchDegrees } = obs.headPose;
  const away =
    Math.abs(yawDegrees) > policy.gazeAway.yawDegrees ||
    Math.abs(pitchDegrees) > policy.gazeAway.pitchDegrees;
  // Head pose is a proxy for gaze; its confidence is that of the face it was measured on.
  return { anomalies, gaze: { away, confidence: primary } };
}

/**
 * Head pose from MediaPipe's 4x4 facial transformation matrix (column-major). Assumes the
 * rotation is applied as yaw (Y) then pitch (X); good enough for "looking away" thresholds.
 */
export function headPoseFromMatrix(m: readonly number[]): HeadPose {
  if (m.length !== 16) throw new RangeError('expected a 4x4 matrix');
  const r = (row: number, col: number) => m[col * 4 + row] as number;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const yaw = Math.asin(Math.max(-1, Math.min(1, -r(2, 0))));
  const pitch = Math.atan2(r(2, 1), r(2, 2));
  return { yawDegrees: toDeg(yaw), pitchDegrees: toDeg(pitch) };
}

// Sustained gaze-away: a violation only when the head is turned away across consecutive samples
// spanning at least gazeAway.sustainedSeconds. One anomaly per continuous run.

export interface GazeState {
  runStart?: number;
  runMinConfidence: number;
  raised: boolean;
}

export function createGazeState(): GazeState {
  return { runMinConfidence: 1, raised: false };
}

export function stepGaze(
  state: GazeState,
  ts: number,
  sample: GazeSample | undefined,
  policy: Policy,
): { state: GazeState; anomaly?: DetectedAnomaly } {
  // A frame without a confident face, or looking at the screen, ends the run.
  if (!sample?.away) return { state: createGazeState() };
  const runStart = state.runStart ?? ts;
  const runMinConfidence = Math.min(
    state.runStart === undefined ? 1 : state.runMinConfidence,
    sample.confidence,
  );
  const next: GazeState = { runStart, runMinConfidence, raised: state.raised };
  const sustained = ts - runStart >= policy.gazeAway.sustainedSeconds * 1000;
  if (!sustained || state.raised || runMinConfidence < policy.video.minConfidence) {
    return { state: next };
  }
  return {
    state: { ...next, raised: true },
    anomaly: { type: 'gaze_away_sustained', ts, confidence: runMinConfidence },
  };
}

// Slow devices: if the median inference time is over budget, sample fewer frames per window.

export interface SamplingPlan {
  framesPerWindow: number;
  degraded: boolean;
  medianInferenceMs?: number;
}

export function planSampling(inferenceMs: readonly number[], policy: Policy): SamplingPlan {
  if (inferenceMs.length === 0)
    return { framesPerWindow: policy.sampling.framesPerWindow, degraded: false };
  const sorted = [...inferenceMs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  const degraded = median > policy.video.inferenceBudgetMs;
  return {
    // Degrading never increases the rate, even if the admin set a very low normal rate.
    framesPerWindow: degraded
      ? Math.min(policy.video.degradedFramesPerWindow, policy.sampling.framesPerWindow)
      : policy.sampling.framesPerWindow,
    degraded,
    medianInferenceMs: median,
  };
}

/** The policy with the plan's frame count, for sampleFrameTimes. */
export function withFramesPerWindow(policy: Policy, framesPerWindow: number): Policy {
  return { ...policy, sampling: { ...policy.sampling, framesPerWindow } };
}
