import { z } from 'zod';
import { SEVERITIES, VIOLATION_TYPES } from './catalogue';

/** Numerical tolerance for "weights sum to 1" (floating point), not a product threshold. */
export const WEIGHT_SUM_TOLERANCE = 1e-9;

const positive = z.number().positive();
const weight = z.number().min(0).max(1);

export const SeveritySchema = z.enum(SEVERITIES);
export const ViolationTypeSchema = z.enum(VIOLATION_TYPES);

const PolicyObjectSchema = z.strictObject({
  weights: z
    .strictObject({ browser: weight, video: weight, audio: weight })
    .refine((w) => Math.abs(w.browser + w.video + w.audio - 1) <= WEIGHT_SUM_TOLERANCE, {
      message: 'weights must sum to 1',
    }),
  severityPoints: z.strictObject({ low: positive, medium: positive, high: positive }),
  bands: z
    .strictObject({ lowMax: positive, mediumMax: positive })
    .refine((b) => b.lowMax < b.mediumMax && b.mediumMax < 100, {
      message: 'bands must satisfy 0 < lowMax < mediumMax < 100',
    }),
  // z.record over an enum is exhaustive: every violation type must have a severity.
  severityByType: z.record(ViolationTypeSchema, SeveritySchema),
  sampling: z
    .strictObject({
      framesPerWindow: z.number().int().positive(),
      windowSeconds: positive,
    })
    .refine((s) => s.windowSeconds * 1000 >= s.framesPerWindow, {
      message: 'sampling slots must be at least 1 ms wide',
    }),
  audio: z
    .strictObject({
      /** In-memory rolling buffer kept before speech starts (never stored unless speech). */
      bufferSeconds: positive,
      /** Hard cap on one evidence clip, including the buffer. */
      maxClipSeconds: positive,
      /** Voice-activity probability (0-1) at or above which a frame counts as speech. */
      vadThreshold: z.number().min(0).max(1),
      /** Continuous speech needed before a clip starts (ignores coughs and clicks). */
      minSpeechMs: positive,
      /** Silence that ends a clip, and that must pass after a capped clip before the next. */
      silenceEndMs: positive,
      /**
       * Multiple-voice heuristic (pitch clustering). Unvalidated: confidence is capped at
       * maxConfidence and must be calibrated in the pilot.
       */
      multiVoice: z.strictObject({
        /** Ratio between the two pitch clusters' medians that suggests two speakers. */
        minPitchRatio: z.number().gt(1),
        /** Share of voiced frames each cluster must hold (0-0.5). */
        minClusterShare: z.number().min(0).max(0.5),
        maxConfidence: z.number().min(0).max(1),
        /** Confidence needed to raise multiple_voices. */
        minConfidence: z.number().min(0).max(1),
      }),
    })
    .refine((a) => a.bufferSeconds <= a.maxClipSeconds, {
      message: 'audio.bufferSeconds must not exceed audio.maxClipSeconds',
    }),
  capture: z
    .strictObject({
      eventsBeforeSeconds: positive,
      eventsAfterSeconds: positive,
      burstFrames: z.number().int().min(0),
      logRetentionSeconds: positive,
    })
    .refine((c) => c.logRetentionSeconds >= c.eventsBeforeSeconds + c.eventsAfterSeconds, {
      message: 'capture.logRetentionSeconds must cover eventsBeforeSeconds + eventsAfterSeconds',
    }),
  merge: z.strictObject({
    windowSeconds: positive,
    countMultipliesPoints: z.boolean(),
  }),
  inactivity: z
    .strictObject({
      seconds: positive,
      /** How often the page reports activity/ticks to the rule engine. */
      pingSeconds: positive,
    })
    .refine((i) => i.pingSeconds < i.seconds, {
      message: 'inactivity.pingSeconds must be shorter than inactivity.seconds',
    }),
  gazeAway: z.strictObject({
    sustainedSeconds: positive,
    /** Head turned left/right beyond this many degrees counts as looking away. */
    yawDegrees: z.number().positive().max(90),
    /** Head tilted up/down beyond this many degrees counts as looking away. */
    pitchDegrees: z.number().positive().max(90),
  }),
  /** On-device webcam analysis (Phase 4). */
  video: z.strictObject({
    /** Minimum model score (0-1) for a detection to count and for a video anomaly to be raised. */
    minConfidence: z.number().min(0).max(1),
    /** Median per-frame inference time above which sampling is reduced on this device. */
    inferenceBudgetMs: positive,
    /** Frames per window once the device is over budget. */
    degradedFramesPerWindow: z.number().int().positive(),
    /** Spacing of the extra burst frames captured after an anomalous frame. */
    burstIntervalMs: positive,
  }),
  /**
   * Optional face matching (Phase 11): compares the face in each sampled frame with a reference
   * taken on the device at the start of the session. Runs only when enabled here AND the
   * candidate opted in separately on the consent notice. The reference exists only in the
   * offscreen document's memory and is never stored or uploaded.
   */
  faceMatch: z.strictObject({
    enabled: z.boolean(),
    /** Consistent single-face samples averaged into the session's reference. */
    enrolSamples: z.number().int().positive(),
    /** Spacing of the extra reference frames taken right after the camera starts. */
    enrolIntervalMs: positive,
    /** How long those extra frames are taken; afterwards regular samples finish the reference. */
    enrolMaxSeconds: positive,
    /** Cosine similarity (-1 to 1) to the reference below which a face counts as different. */
    minSimilarity: z.number().min(-1).max(1),
    /** Consecutive sampled frames with a different face needed to raise face_mismatch. */
    consecutiveSamples: z.number().int().positive(),
  }),
  retentionDays: z.number().int().positive(),
  /** Evidence upload queue on the candidate's device (Phase 6). */
  upload: z
    .strictObject({
      /** First retry delay; doubles per failed attempt (with jitter). */
      retryBaseMs: positive,
      /** Longest delay between retries. */
      retryMaxMs: positive,
      /** Local queue size cap; lowest-value anomalies (with their evidence) are evicted first. */
      maxQueueBytes: z.number().int().positive(),
    })
    .refine((u) => u.retryBaseMs <= u.retryMaxMs, {
      message: 'upload.retryBaseMs must not exceed upload.retryMaxMs',
    }),
  /** Pre-test setup check (a readiness check for the candidate, never an exam result). */
  setupCheck: z.strictObject({
    sampleSeconds: positive,
    /** How often the check samples the preview and microphone while it runs. */
    measureIntervalMs: positive,
    /** Minimum detector confidence (0-1) for a face to count as present. */
    faceMinConfidence: z.number().min(0).max(1),
    /** Minimum peak RMS level (0-1) for the microphone to count as working. */
    micLevelMin: z.number().min(0).max(1),
    /** Share of sampled frames that must contain a face. */
    faceFrameRatioMin: z.number().min(0).max(1),
    /** Median on-device face-detection time above which the device needs attention. */
    inferenceBudgetMs: positive,
  }),
});

/**
 * Policies stored before Phase 11 (versions, session snapshots) have no face matching. They
 * read as "face matching off" with the default face_mismatch severity; nothing else changes,
 * so their scores are reproduced exactly.
 */
function upgradeLegacyPolicy(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const p = input as Record<string, unknown>;
  const severities = p.severityByType;
  const upgraded = { ...p };
  if (!('faceMatch' in p)) upgraded.faceMatch = { ...DEFAULT_POLICY.faceMatch, enabled: false };
  if (typeof severities === 'object' && severities !== null && !('face_mismatch' in severities)) {
    upgraded.severityByType = {
      ...severities,
      face_mismatch: DEFAULT_POLICY.severityByType.face_mismatch,
    };
  }
  return upgraded;
}

export const PolicySchema = z.preprocess(upgradeLegacyPolicy, PolicyObjectSchema);

export type Policy = z.infer<typeof PolicyObjectSchema>;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** PRD defaults. The only place product numbers may be written down. */
export const DEFAULT_POLICY: Policy = deepFreeze({
  weights: { browser: 0.4, video: 0.4, audio: 0.2 },
  severityPoints: { low: 5, medium: 15, high: 30 },
  bands: { lowMax: 29, mediumMax: 59 },
  severityByType: {
    fullscreen_exit: 'medium',
    tab_switch_or_blur: 'medium',
    copy_paste: 'low',
    refresh_attempt: 'low',
    inactivity: 'low',
    no_face: 'medium',
    multiple_faces: 'high',
    phone_detected: 'high',
    book_or_notes: 'medium',
    gaze_away_sustained: 'low',
    // ASSUMPTION: not in the PRD. Medium, not high: face matching has known error rates that
    // vary with lighting, camera and demographics (docs/FAIRNESS.md).
    face_mismatch: 'medium',
    speech_detected: 'medium',
    multiple_voices: 'high',
  },
  sampling: { framesPerWindow: 5, windowSeconds: 30 },
  audio: {
    bufferSeconds: 10,
    maxClipSeconds: 30,
    // ASSUMPTION: VAD and multi-voice numbers are not in the PRD; calibrate in the pilot.
    vadThreshold: 0.5,
    minSpeechMs: 250,
    silenceEndMs: 1500,
    // Measured on a 60 s single-speaker recording: natural intonation reached a 1.63 pitch-group
    // ratio, so 1.7 avoids those false positives; similar-pitch voices are mostly missed.
    multiVoice: {
      minPitchRatio: 1.7,
      minClusterShare: 0.25,
      maxConfidence: 0.6,
      minConfidence: 0.3,
    },
  },
  capture: {
    eventsBeforeSeconds: 30,
    eventsAfterSeconds: 15,
    burstFrames: 3,
    logRetentionSeconds: 60, // ASSUMPTION: BUILD_PLAN Phase 3 "last >= 60 s"
  },
  merge: {
    windowSeconds: 60, // ASSUMPTION: PRD says "short span"
    countMultipliesPoints: false, // OPEN QUESTION: see README
  },
  inactivity: { seconds: 60, pingSeconds: 5 }, // ASSUMPTION: not specified in PRD
  // ASSUMPTION: none of the gaze/video numbers below are in the PRD; calibrate in the pilot.
  gazeAway: { sustainedSeconds: 5, yawDegrees: 30, pitchDegrees: 25 },
  video: {
    minConfidence: 0.5,
    inferenceBudgetMs: 250,
    degradedFramesPerWindow: 3,
    burstIntervalMs: 1000,
  },
  faceMatch: {
    // Off unless an organisation turns it on (biometric processing needs its own legal basis).
    enabled: false,
    // ASSUMPTION: none of these are in the PRD. minSimilarity is the SFace model's published
    // cosine threshold (OpenCV Zoo); calibrate on pilot data (docs/FAIRNESS.md).
    enrolSamples: 5,
    enrolIntervalMs: 1000,
    enrolMaxSeconds: 30,
    minSimilarity: 0.363,
    consecutiveSamples: 3,
  },
  retentionDays: 30, // ASSUMPTION: open question in PRD
  // ASSUMPTION: not in the PRD; tune in the pilot.
  upload: { retryBaseMs: 2000, retryMaxMs: 300_000, maxQueueBytes: 100 * 1024 * 1024 },
  setupCheck: {
    // ASSUMPTION: none of these are in the PRD; calibrate in the pilot.
    sampleSeconds: 3,
    measureIntervalMs: 200,
    faceMinConfidence: 0.5,
    micLevelMin: 0.02,
    faceFrameRatioMin: 0.5,
    inferenceBudgetMs: 200,
  },
});

/** Validates untrusted policy input. Throws a ZodError describing every problem. */
export function parsePolicy(input: unknown): Policy {
  return PolicySchema.parse(input);
}
