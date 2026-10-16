import type { Policy } from './policy';
import type { DetectedAnomaly } from './schemas';

// Optional face matching (Phase 11, policy.faceMatch): is the face in a sampled frame the same
// face that was seen at the start of the session? Pure rules only. The embedding model runs in
// the extension's offscreen document; embeddings and the reference live in its memory for the
// session and are never stored or uploaded. The result is a flag for human review, never an
// identity decision.

/**
 * Consent notice version recorded when the candidate accepted the notice AND separately opted
 * in to face matching (the standard notice is 'consent-notice-v1').
 */
export const FACE_MATCH_NOTICE_VERSION = 'consent-notice-v1+face-match-v1';

/** Whether face matching ran for a session, as far as the server can tell. */
export type FaceMatchStatus = 'not_offered' | 'not_opted_in' | 'opted_in';

/** From the session's policy snapshot and the notice version of its accepted consent. */
export function faceMatchStatus(
  policy: Policy,
  acceptedNoticeVersion: string | undefined,
): FaceMatchStatus {
  if (!policy.faceMatch.enabled) return 'not_offered';
  return acceptedNoticeVersion === FACE_MATCH_NOTICE_VERSION ? 'opted_in' : 'not_opted_in';
}

export interface Point {
  x: number;
  y: number;
}

/** RGBA pixels, row-major (ImageData layout). */
export interface RgbaImage {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

/** Input size of the embedding model (SFace, OpenCV Zoo). */
export const FACE_CROP_SIZE = 112;

/**
 * Where the eyes, nose tip and mouth centre sit in the model's 112x112 aligned crop: the
 * standard ArcFace/SFace 5-point template, with the two mouth corners averaged into one centre
 * because the face detector reports a mouth centre. A model contract, not a product threshold.
 */
export const FACE_TEMPLATE: readonly Point[] = Object.freeze([
  { x: 38.2946, y: 51.6963 }, // eye on the image's left
  { x: 73.5318, y: 51.5014 }, // eye on the image's right
  { x: 56.0252, y: 71.7366 }, // nose tip
  { x: 56.1396, y: 92.2848 }, // mouth centre
]);

/** x' = a·x − b·y + tx, y' = b·x + a·y + ty (rotation, uniform scale, translation). */
export interface SimilarityTransform {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

/** Least-squares similarity transform mapping `src` points onto `dst` (no reflection). */
export function similarityTransform(
  src: readonly Point[],
  dst: readonly Point[],
): SimilarityTransform {
  if (src.length !== dst.length || src.length < 2) {
    throw new RangeError('need at least two matching point pairs');
  }
  const n = src.length;
  const mean = (ps: readonly Point[]) => ({
    x: ps.reduce((s, p) => s + p.x, 0) / n,
    y: ps.reduce((s, p) => s + p.y, 0) / n,
  });
  const ms = mean(src);
  const md = mean(dst);
  let dot = 0;
  let cross = 0;
  let norm = 0;
  for (let i = 0; i < n; i++) {
    const s = src[i] as Point;
    const d = dst[i] as Point;
    const sx = s.x - ms.x;
    const sy = s.y - ms.y;
    const dx = d.x - md.x;
    const dy = d.y - md.y;
    dot += sx * dx + sy * dy;
    cross += sx * dy - sy * dx;
    norm += sx * sx + sy * sy;
  }
  if (norm === 0) throw new RangeError('source points coincide');
  const a = dot / norm;
  const b = cross / norm;
  return { a, b, tx: md.x - (a * ms.x - b * ms.y), ty: md.y - (b * ms.x + a * ms.y) };
}

/**
 * The face as the embedding model expects it: rotated, scaled and cropped so the eyes, nose and
 * mouth land on FACE_TEMPLATE, as a 3x112x112 float tensor (RGB planes, 0-255). Pixels outside
 * the frame are black. `keypoints` are the detector's eyes (either order), nose tip and mouth
 * centre, in pixels.
 */
export function alignFace(image: RgbaImage, keypoints: readonly Point[]): Float32Array {
  if (keypoints.length !== 4) throw new RangeError('expected eyes, nose tip and mouth centre');
  const [e1, e2, nose, mouth] = keypoints as [Point, Point, Point, Point];
  // Match eyes by image position so the detector's left/right naming does not matter.
  const eyes = e1.x <= e2.x ? [e1, e2] : [e2, e1];
  const t = similarityTransform([...eyes, nose, mouth], FACE_TEMPLATE);
  const det = t.a * t.a + t.b * t.b;
  const { width, height, data } = image;
  const size = FACE_CROP_SIZE;
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  const px = (x: number, y: number, c: number) =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : (data[(y * width + x) * 4 + c] as number);

  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      // Inverse transform: where in the frame this crop pixel comes from.
      const du = u - t.tx;
      const dv = v - t.ty;
      const x = (t.a * du + t.b * dv) / det;
      const y = (-t.b * du + t.a * dv) / det;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      for (let c = 0; c < 3; c++) {
        const top = px(x0, y0, c) * (1 - fx) + px(x0 + 1, y0, c) * fx;
        const bottom = px(x0, y0 + 1, c) * (1 - fx) + px(x0 + 1, y0 + 1, c) * fx;
        out[c * plane + v * size + u] = top * (1 - fy) + bottom * fy;
      }
    }
  }
  return out;
}

/** Unit-length copy of a vector (a zero vector stays zero). */
export function normalize(v: ArrayLike<number>): number[] {
  const values = Array.from(v);
  const length = Math.hypot(...values);
  return length === 0 ? values.map(() => 0) : values.map((x) => x / length);
}

/** Cosine similarity of two vectors of the same length, from -1 to 1 (0 if either is zero). */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new RangeError('vectors differ in length');
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Unit-length mean of unit-length embeddings. */
export function meanEmbedding(embeddings: readonly (readonly number[])[]): number[] {
  const first = embeddings[0];
  if (!first) throw new RangeError('no embeddings');
  const sum = first.map((_, i) => embeddings.reduce((s, e) => s + (e[i] as number), 0));
  return normalize(sum);
}

/**
 * A frame counts for face matching only when it shows exactly one face at or above
 * policy.video.minConfidence (no face and several faces have their own rules). Returns that
 * face's score, or undefined.
 */
export function singleFaceScore(faceScores: readonly number[], policy: Policy): number | undefined {
  const faces = faceScores.filter((s) => s >= policy.video.minConfidence);
  return faces.length === 1 ? faces[0] : undefined;
}

// State machine. Enrolling: collects policy.faceMatch.enrolSamples consistent embeddings (each
// at least minSimilarity to the mean so far; an inconsistent one restarts collection, so two
// people never blend into one reference). Enrolled: compares each sample with the reference;
// face_mismatch needs consecutiveSamples different faces in a row, one anomaly per run.

export type FaceMatchState =
  | { phase: 'enrolling'; samples: number[][] }
  | {
      phase: 'enrolled';
      reference: number[];
      /** Consecutive different-face samples in the current run. */
      run: number;
      /** Highest similarity seen in the run (the run's weakest evidence of a different face). */
      runMaxSimilarity: number;
      raised: boolean;
    };

export function createFaceMatchState(): FaceMatchState {
  return { phase: 'enrolling', samples: [] };
}

export interface FaceMatchStep {
  state: FaceMatchState;
  /** True on the sample that completed the reference. */
  enrolled?: boolean;
  /** Similarity of this sample to the reference (enrolled phase only). */
  similarity?: number;
  anomaly?: DetectedAnomaly;
}

/**
 * One sampled frame. `embedding` is undefined when the frame did not show exactly one confident
 * face; such a frame ends a different-face run (as for gaze) and does not count for enrolment.
 */
export function stepFaceMatch(
  state: FaceMatchState,
  ts: number,
  embedding: ArrayLike<number> | undefined,
  policy: Policy,
): FaceMatchStep {
  const { enrolSamples, minSimilarity, consecutiveSamples } = policy.faceMatch;

  if (state.phase === 'enrolling') {
    if (!embedding) return { state };
    const sample = normalize(embedding);
    const consistent =
      state.samples.length === 0 ||
      cosineSimilarity(sample, meanEmbedding(state.samples)) >= minSimilarity;
    const samples = consistent ? [...state.samples, sample] : [sample];
    if (samples.length < enrolSamples) return { state: { phase: 'enrolling', samples } };
    return {
      state: {
        phase: 'enrolled',
        reference: meanEmbedding(samples),
        run: 0,
        runMaxSimilarity: -1,
        raised: false,
      },
      enrolled: true,
    };
  }

  const reset = { ...state, run: 0, runMaxSimilarity: -1, raised: false };
  if (!embedding) return { state: reset };
  const similarity = cosineSimilarity(embedding, state.reference);
  if (similarity >= minSimilarity) return { state: reset, similarity };

  const run = state.run + 1;
  const runMaxSimilarity = Math.max(state.runMaxSimilarity, similarity);
  const next = { ...state, run, runMaxSimilarity };
  if (run < consecutiveSamples || state.raised) return { state: next, similarity };
  return {
    state: { ...next, raised: true },
    similarity,
    // Confidence that the face differs: 1 − the closest similarity in the run, within [0, 1].
    anomaly: {
      type: 'face_mismatch',
      ts,
      confidence: Math.min(1, Math.max(0, 1 - runMaxSimilarity)),
    },
  };
}
