import type { Policy } from '@proctor/core';
import type { CheckStatus, SetupResult } from '../messages';

// Pre-test setup check: a readiness check for the candidate's equipment. Results are
// "ready" or "needs_attention" and never gate or judge the exam.

export interface SetupMeasurements {
  /** Faces found in each analysed preview frame. */
  faceCounts: number[];
  /** RMS level (0-1) of each microphone sample. */
  micLevels: number[];
  /** Face-detection time per frame, ms. */
  inferenceMs: number[];
  /** Whether the on-device face model loaded. */
  modelLoaded: boolean;
}

export interface CheckOutcome {
  status: CheckStatus;
  message: string;
}

export interface SetupEvaluation {
  result: SetupResult;
  face: CheckOutcome;
  mic: CheckOutcome;
  performance: CheckOutcome;
}

export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] as number;
  return sorted.length % 2 === 1 ? hi : ((sorted[mid - 1] as number) + hi) / 2;
}

const ready = (message: string): CheckOutcome => ({ status: 'ready', message });
const attention = (message: string): CheckOutcome => ({ status: 'needs_attention', message });

export function evaluateSetup(m: SetupMeasurements, policy: Policy): SetupEvaluation {
  const { faceFrameRatioMin, micLevelMin, inferenceBudgetMs } = policy.setupCheck;

  let face: CheckOutcome;
  if (!m.modelLoaded) {
    face = attention('The face check could not run on this device.');
  } else {
    const withFace = m.faceCounts.filter((n) => n >= 1).length;
    const ratio = m.faceCounts.length === 0 ? 0 : withFace / m.faceCounts.length;
    face =
      ratio >= faceFrameRatioMin
        ? ready('Your face is visible.')
        : attention(
            'We could not see your face clearly. Face the camera and improve the lighting.',
          );
  }

  const peak = m.micLevels.length === 0 ? 0 : Math.max(...m.micLevels);
  const mic =
    peak >= micLevelMin
      ? ready('Your microphone is picking up sound.')
      : attention(
          'We could not hear anything. Check that your microphone is on and say a few words.',
        );

  const typical = median(m.inferenceMs);
  const performance =
    m.modelLoaded && typical !== undefined && typical <= inferenceBudgetMs
      ? ready('Your device can run the checks smoothly.')
      : attention('Your device may be slow. Close other apps and browser tabs if you can.');

  return {
    result: { face: face.status, mic: mic.status, performance: performance.status },
    face,
    mic,
    performance,
  };
}
