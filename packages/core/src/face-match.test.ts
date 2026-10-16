import { describe, expect, it } from 'vitest';
import {
  FACE_CROP_SIZE,
  FACE_MATCH_NOTICE_VERSION,
  FACE_TEMPLATE,
  alignFace,
  cosineSimilarity,
  createFaceMatchState,
  faceMatchStatus,
  meanEmbedding,
  normalize,
  similarityTransform,
  singleFaceScore,
  stepFaceMatch,
  type FaceMatchState,
  type Point,
  type RgbaImage,
} from './face-match';
import { DEFAULT_POLICY, parsePolicy, type Policy } from './policy';

const P: Policy = parsePolicy({
  ...DEFAULT_POLICY,
  faceMatch: { ...DEFAULT_POLICY.faceMatch, enabled: true },
});

const apply = (t: ReturnType<typeof similarityTransform>, p: Point): Point => ({
  x: t.a * p.x - t.b * p.y + t.tx,
  y: t.b * p.x + t.a * p.y + t.ty,
});

describe('faceMatchStatus', () => {
  it('needs the policy and the opt-in notice', () => {
    expect(faceMatchStatus(DEFAULT_POLICY, FACE_MATCH_NOTICE_VERSION)).toBe('not_offered');
    expect(faceMatchStatus(P, 'consent-notice-v1')).toBe('not_opted_in');
    expect(faceMatchStatus(P, undefined)).toBe('not_opted_in');
    expect(faceMatchStatus(P, FACE_MATCH_NOTICE_VERSION)).toBe('opted_in');
  });
});

describe('similarityTransform', () => {
  it('recovers a known rotation, scale and translation exactly', () => {
    const angle = 0.3;
    const scale = 1.7;
    const known = {
      a: scale * Math.cos(angle),
      b: scale * Math.sin(angle),
      tx: 12,
      ty: -5,
    };
    const src = [
      { x: 0, y: 0 },
      { x: 10, y: 3 },
      { x: -4, y: 8 },
    ];
    const t = similarityTransform(
      src,
      src.map((p) => apply(known, p)),
    );
    expect(t.a).toBeCloseTo(known.a, 10);
    expect(t.b).toBeCloseTo(known.b, 10);
    expect(t.tx).toBeCloseTo(known.tx, 10);
    expect(t.ty).toBeCloseTo(known.ty, 10);
  });

  it('rejects mismatched, too few or coinciding points', () => {
    const p = { x: 1, y: 1 };
    expect(() => similarityTransform([p], [p])).toThrow(RangeError);
    expect(() => similarityTransform([p, p], [p])).toThrow(RangeError);
    expect(() => similarityTransform([p, p], [p, { x: 2, y: 2 }])).toThrow(/coincide/);
  });
});

/** Solid image with one bright pixel per channel marker, for checking the warp. */
function image(width: number, height: number, fill: (x: number, y: number) => number[]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r = 0, g = 0, b = 0] = fill(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  return { data, width, height } satisfies RgbaImage;
}

describe('alignFace', () => {
  const plane = FACE_CROP_SIZE * FACE_CROP_SIZE;
  const at = (out: Float32Array, c: number, u: number, v: number) =>
    out[c * plane + v * FACE_CROP_SIZE + u] as number;

  it('is the identity when the keypoints already sit on the template', () => {
    // Pixel value encodes its position, so a pure copy is easy to see.
    const img = image(FACE_CROP_SIZE, FACE_CROP_SIZE, (x, y) => [x, y, 7]);
    const out = alignFace(img, FACE_TEMPLATE);
    expect(out).toHaveLength(3 * plane);
    for (const [u, v] of [
      [0, 0],
      [50, 60],
      [111, 111],
    ] as const) {
      expect(at(out, 0, u, v)).toBeCloseTo(u, 3); // R plane
      expect(at(out, 1, u, v)).toBeCloseTo(v, 3); // G plane
      expect(at(out, 2, u, v)).toBeCloseTo(7, 3); // B plane
    }
  });

  it('undoes a scaled and shifted face, and accepts the eyes in either order', () => {
    // A frame twice the crop size with the face drawn 2x larger, offset by (20, 10).
    const img = image(260, 250, (x, y) => [Math.round((x - 20) / 2), Math.round((y - 10) / 2), 0]);
    const keypoints = FACE_TEMPLATE.map((p) => ({ x: p.x * 2 + 20, y: p.y * 2 + 10 }));
    const swapped = [keypoints[1], keypoints[0], keypoints[2], keypoints[3]] as Point[];
    for (const kp of [keypoints, swapped]) {
      const out = alignFace(img, kp);
      expect(at(out, 0, 40, 70)).toBeCloseTo(40, 0);
      expect(at(out, 1, 40, 70)).toBeCloseTo(70, 0);
    }
  });

  it('interpolates between pixels and fills outside the frame with black', () => {
    // Horizontal ramp; template shifted by half a pixel samples between columns.
    const img = image(FACE_CROP_SIZE, FACE_CROP_SIZE, (x) => [x * 2, 0, 0]);
    const half = FACE_TEMPLATE.map((p) => ({ x: p.x + 0.5, y: p.y }));
    expect(at(alignFace(img, half), 0, 10, 10)).toBeCloseTo(21, 3);
    // Face far off to the left: the crop's right edge maps outside the frame.
    const off = FACE_TEMPLATE.map((p) => ({ x: p.x - 200, y: p.y }));
    expect(at(alignFace(img, off), 0, 100, 50)).toBe(0);
  });

  it('needs exactly four keypoints', () => {
    const img = image(4, 4, () => [0, 0, 0]);
    expect(() => alignFace(img, FACE_TEMPLATE.slice(0, 3))).toThrow(RangeError);
  });
});

describe('vector helpers', () => {
  it('normalizes to unit length and keeps a zero vector zero', () => {
    expect(normalize([3, 4])).toEqual([0.6, 0.8]);
    expect(normalize([0, 0])).toEqual([0, 0]);
  });

  it('computes cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 3])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(() => cosineSimilarity([1], [1, 2])).toThrow(RangeError);
  });

  it('averages unit embeddings into a unit mean', () => {
    const m = meanEmbedding([
      [1, 0],
      [0, 1],
    ]);
    expect(m[0]).toBeCloseTo(Math.SQRT1_2);
    expect(m[1]).toBeCloseTo(Math.SQRT1_2);
    expect(() => meanEmbedding([])).toThrow(RangeError);
  });
});

describe('singleFaceScore', () => {
  it('returns the score only when exactly one face is confident', () => {
    expect(singleFaceScore([0.9, 0.2], P)).toBe(0.9);
    expect(singleFaceScore([], P)).toBeUndefined();
    expect(singleFaceScore([0.3], P)).toBeUndefined();
    expect(singleFaceScore([0.9, 0.8], P)).toBeUndefined();
  });
});

// Embeddings at a chosen angle from the reference direction [1, 0]: cos(angle) = similarity.
const face = (similarity: number) => [similarity, Math.sqrt(1 - similarity ** 2)];
const SAME = face(1);
const OTHER = face(0.1);

function run(samples: (number[] | undefined)[], policy = P, from = createFaceMatchState()) {
  let state: FaceMatchState = from;
  const steps = samples.map((s, i) => {
    const step = stepFaceMatch(state, i * 6000, s, policy);
    state = step.state;
    return step;
  });
  return { state, steps };
}

const enrolled = () => run(Array<number[]>(P.faceMatch.enrolSamples).fill(SAME)).state;

describe('stepFaceMatch: enrolment', () => {
  it('builds the reference from enrolSamples consistent samples, reporting completion once', () => {
    const { state, steps } = run(Array<number[]>(P.faceMatch.enrolSamples + 1).fill(SAME));
    expect(steps.map((s) => s.enrolled === true)).toEqual([
      false,
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(state.phase).toBe('enrolled');
    if (state.phase === 'enrolled') expect(cosineSimilarity(state.reference, SAME)).toBeCloseTo(1);
  });

  it('ignores frames without a single confident face', () => {
    const { state } = run([SAME, undefined, SAME]);
    expect(state).toEqual({ phase: 'enrolling', samples: [SAME, SAME].map((s) => normalize(s)) });
  });

  it('restarts when a sample does not match the samples so far (never blends two faces)', () => {
    const { state } = run([SAME, SAME, OTHER]);
    expect(state).toEqual({ phase: 'enrolling', samples: [normalize(OTHER)] });
  });

  it('normalizes raw model output', () => {
    const { state } = run([[10, 0]]);
    expect(state).toEqual({ phase: 'enrolling', samples: [[1, 0]] });
  });
});

describe('stepFaceMatch: matching', () => {
  it('stays quiet while the face matches', () => {
    const { steps } = run([SAME, face(0.9), face(0.5)], P, enrolled());
    expect(steps.every((s) => s.anomaly === undefined)).toBe(true);
    expect(steps[1]?.similarity).toBeCloseTo(0.9);
  });

  it('raises face_mismatch after consecutiveSamples different faces, once per run', () => {
    const { steps } = run([OTHER, face(0.2), OTHER, OTHER], P, enrolled());
    expect(steps.map((s) => s.anomaly)).toEqual([
      undefined,
      undefined,
      // Confidence comes from the closest face in the run (0.2).
      { type: 'face_mismatch', ts: 12_000, confidence: expect.closeTo(0.8, 6) as number },
      undefined,
    ]);
  });

  it.each([
    ['a matching face', SAME],
    ['a frame without a single confident face', undefined],
  ])('starts a new run after %s', (_label, interruption) => {
    const { steps } = run([OTHER, OTHER, interruption, OTHER, OTHER, OTHER], P, enrolled());
    expect(steps.map((s) => s.anomaly?.type)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'face_mismatch',
    ]);
  });

  it('treats similarity exactly at the threshold as the same face', () => {
    const at = face(P.faceMatch.minSimilarity);
    const { steps } = run([at, at, at], P, enrolled());
    expect(steps.every((s) => s.anomaly === undefined)).toBe(true);
  });

  it('caps confidence at 1 for opposite embeddings', () => {
    const policy = parsePolicy({ ...P, faceMatch: { ...P.faceMatch, consecutiveSamples: 1 } });
    const { steps } = run([[-1, 0]], policy, enrolled());
    expect(steps[0]?.anomaly?.confidence).toBe(1);
  });
});
