import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, parsePolicy } from './policy';
import {
  analyzeFrame,
  createGazeState,
  headPoseFromMatrix,
  planSampling,
  stepGaze,
  withFramesPerWindow,
  type FrameObservation,
  type GazeSample,
  type GazeState,
  type HeadPose,
} from './video';

const P = DEFAULT_POLICY;
const S = 1000;

type FrameOverrides = Omit<Partial<FrameObservation>, 'headPose'> & {
  /** Pass undefined explicitly to simulate "landmarker found no face". */
  headPose?: HeadPose | undefined;
};

function frame(over: FrameOverrides = {}): FrameObservation {
  const { headPose, ...rest } = over;
  const pose = 'headPose' in over ? headPose : { yawDegrees: 0, pitchDegrees: 0 };
  return {
    ts: 5 * S,
    faceScores: [0.95],
    objects: [],
    ...rest,
    ...(pose ? { headPose: pose } : {}),
  };
}

const types = (o: FrameObservation) => analyzeFrame(o, P).anomalies.map((a) => a.type);

describe('analyzeFrame', () => {
  it('raises nothing for one confident, front-facing face', () => {
    expect(analyzeFrame(frame(), P)).toEqual({
      anomalies: [],
      gaze: { away: false, confidence: 0.95 },
    });
  });

  it('no_face, with confidence = 1 - best sub-threshold face score', () => {
    const a = analyzeFrame(frame({ faceScores: [0.2], headPose: undefined }), P);
    expect(a.anomalies).toEqual([{ type: 'no_face', ts: 5 * S, confidence: 0.8 }]);
    expect(a.gaze).toBeUndefined();
    expect(analyzeFrame(frame({ faceScores: [] }), P).anomalies[0]).toMatchObject({
      confidence: 1,
    });
  });

  it('does not raise no_face when even the absence is uncertain', () => {
    // best face 0.49 -> not a face (min 0.5), but "no face" confidence 0.51 >= 0.5 -> raised
    expect(types(frame({ faceScores: [0.49] }))).toEqual(['no_face']);
    const strict = parsePolicy({ ...P, video: { ...P.video, minConfidence: 0.6 } });
    // best face 0.45 -> no_face confidence 0.55 < 0.6 -> not raised
    expect(analyzeFrame(frame({ faceScores: [0.45] }), strict).anomalies).toEqual([]);
  });

  it('multiple_faces from two confident faces, confidence = second-best score', () => {
    const a = analyzeFrame(frame({ faceScores: [0.6, 0.9, 0.3] }), P);
    expect(a.anomalies).toEqual([{ type: 'multiple_faces', ts: 5 * S, confidence: 0.6 }]);
  });

  it('multiple_faces from an additional person the face detector missed', () => {
    const objects = [
      { category: 'person', score: 0.9 },
      { category: 'person', score: 0.7 },
    ];
    expect(analyzeFrame(frame({ objects }), P).anomalies).toEqual([
      { type: 'multiple_faces', ts: 5 * S, confidence: 0.7 },
    ]);
    // one person only, or a weak second person: nothing
    expect(types(frame({ objects: [{ category: 'person', score: 0.9 }] }))).toEqual([]);
    expect(
      types(
        frame({
          objects: [
            { category: 'person', score: 0.9 },
            { category: 'person', score: 0.3 },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('phone and book detections above threshold, using the best score', () => {
    const objects = [
      { category: 'cell phone', score: 0.55 },
      { category: 'cell phone', score: 0.8 },
      { category: 'book', score: 0.6 },
      { category: 'book', score: 0.2 },
      { category: 'cup', score: 0.99 },
    ];
    expect(analyzeFrame(frame({ objects }), P).anomalies).toEqual([
      { type: 'phone_detected', ts: 5 * S, confidence: 0.8 },
      { type: 'book_or_notes', ts: 5 * S, confidence: 0.6 },
    ]);
    expect(types(frame({ objects: [{ category: 'cell phone', score: 0.4 }] }))).toEqual([]);
  });

  it('reports gaze away when yaw or pitch exceeds the policy angles', () => {
    expect(analyzeFrame(frame({ headPose: { yawDegrees: -31, pitchDegrees: 0 } }), P).gaze).toEqual(
      {
        away: true,
        confidence: 0.95,
      },
    );
    expect(
      analyzeFrame(frame({ headPose: { yawDegrees: 0, pitchDegrees: 26 } }), P).gaze?.away,
    ).toBe(true);
    expect(
      analyzeFrame(frame({ headPose: { yawDegrees: 30, pitchDegrees: -25 } }), P).gaze?.away,
    ).toBe(false);
    expect(analyzeFrame(frame({ headPose: undefined }), P).gaze).toBeUndefined();
  });
});

describe('headPoseFromMatrix', () => {
  // Column-major 4x4 for rotation R (3x3) with no translation.
  const matrix = (R: number[][]) => {
    const m = new Array<number>(16).fill(0);
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 3; col++) m[col * 4 + row] = R[row]?.[col] ?? 0;
    m[15] = 1;
    return m;
  };
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const rotY = (d: number) => [
    [Math.cos(rad(d)), 0, Math.sin(rad(d))],
    [0, 1, 0],
    [-Math.sin(rad(d)), 0, Math.cos(rad(d))],
  ];
  const rotX = (d: number) => [
    [1, 0, 0],
    [0, Math.cos(rad(d)), -Math.sin(rad(d))],
    [0, Math.sin(rad(d)), Math.cos(rad(d))],
  ];

  it('reads yaw and pitch', () => {
    expect(headPoseFromMatrix(matrix(rotY(0))).yawDegrees).toBeCloseTo(0);
    expect(headPoseFromMatrix(matrix(rotY(40))).yawDegrees).toBeCloseTo(40);
    expect(headPoseFromMatrix(matrix(rotY(-25))).yawDegrees).toBeCloseTo(-25);
    expect(headPoseFromMatrix(matrix(rotX(20))).pitchDegrees).toBeCloseTo(20);
    expect(headPoseFromMatrix(matrix(rotX(20))).yawDegrees).toBeCloseTo(0);
  });

  it('clamps numerical noise and rejects malformed input', () => {
    const m = matrix(rotY(90));
    m[2] = -1.0000001; // |sin| slightly above 1
    expect(headPoseFromMatrix(m).yawDegrees).toBeCloseTo(90);
    expect(() => headPoseFromMatrix([1, 2, 3])).toThrow(RangeError);
  });
});

describe('stepGaze (sustained gaze away)', () => {
  const away = (confidence = 0.9): GazeSample => ({ away: true, confidence });
  const run = (samples: [number, GazeSample | undefined][], policy = P) => {
    let state: GazeState = createGazeState();
    const out = [];
    for (const [ts, s] of samples) {
      const step = stepGaze(state, ts, s, policy);
      state = step.state;
      if (step.anomaly) out.push(step.anomaly);
    }
    return out;
  };

  it('raises once when looking away across samples spanning sustainedSeconds', () => {
    expect(
      run([
        [0, away(0.9)],
        [3 * S, away(0.7)],
        [5 * S, away(0.8)],
        [9 * S, away(0.9)],
      ]),
    ).toEqual([{ type: 'gaze_away_sustained', ts: 5 * S, confidence: 0.7 }]);
  });

  it('a single away sample, or a run broken by looking back, raises nothing', () => {
    expect(run([[0, away()]])).toEqual([]);
    expect(
      run([
        [0, away()],
        [3 * S, { away: false, confidence: 0.9 }],
        [6 * S, away()],
      ]),
    ).toEqual([]);
  });

  it('a frame without a face breaks the run', () => {
    expect(
      run([
        [0, away()],
        [3 * S, undefined],
        [6 * S, away()],
      ]),
    ).toEqual([]);
  });

  it('a new run after looking back can raise again', () => {
    expect(
      run([
        [0, away()],
        [6 * S, away()],
        [7 * S, { away: false, confidence: 0.9 }],
        [8 * S, away()],
        [14 * S, away()],
      ]).map((a) => a.ts),
    ).toEqual([6 * S, 14 * S]);
  });

  it('does not raise when the run includes a below-threshold confidence', () => {
    expect(
      run([
        [0, away(0.9)],
        [6 * S, away(0.4)],
      ]),
    ).toEqual([]);
  });

  it('follows the policy duration', () => {
    const quick = parsePolicy({ ...P, gazeAway: { ...P.gazeAway, sustainedSeconds: 1 } });
    expect(
      run(
        [
          [0, away()],
          [1 * S, away()],
        ],
        quick,
      ),
    ).toHaveLength(1);
  });
});

describe('planSampling (slow devices)', () => {
  it('keeps the normal rate with no measurements or within budget', () => {
    expect(planSampling([], P)).toEqual({ framesPerWindow: 5, degraded: false });
    expect(planSampling([100, 300, 200], P)).toEqual({
      framesPerWindow: 5,
      degraded: false,
      medianInferenceMs: 200,
    });
  });

  it('degrades when the median is over budget (even count median)', () => {
    expect(planSampling([200, 300, 400, 260], P)).toEqual({
      framesPerWindow: 3,
      degraded: true,
      medianInferenceMs: 280,
    });
  });

  it('never raises the rate when the normal rate is already below the degraded one', () => {
    const sparse = parsePolicy({ ...P, sampling: { framesPerWindow: 2, windowSeconds: 30 } });
    expect(planSampling([999], sparse).framesPerWindow).toBe(2);
  });

  it('applies a frame count to the policy without mutating it', () => {
    const p = withFramesPerWindow(P, 3);
    expect(p.sampling.framesPerWindow).toBe(3);
    expect(P.sampling.framesPerWindow).toBe(5);
  });
});
