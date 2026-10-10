import type { Policy } from './policy';
import type { DetectedAnomaly } from './schemas';

// On-device audio monitoring (FR3, FR4, BUILD_PLAN Phase 5). Pure logic only: the extension
// feeds 16 kHz mono frames with a voice-activity probability per frame.
//
// Privacy by construction:
// - While silent, audio lives only in a rolling in-memory buffer of audio.bufferSeconds.
// - A clip is produced only once speech has lasted audio.minSpeechMs: buffer + audio until
//   audio.silenceEndMs of silence, hard-capped at audio.maxClipSeconds.
// - After a capped clip nothing is recorded until silence returns, so continuous talking can
//   never turn into continuous recording.

export interface AudioFrame {
  /** Start time of the frame, epoch ms. */
  ts: number;
  /** Mono PCM in [-1, 1]. */
  samples: Float32Array;
  /** Voice-activity probability for this frame (0-1). */
  speechProb: number;
}

export interface AudioClip {
  startTs: number;
  endTs: number;
  /** When the triggering speech began (anomaly time). */
  speechStartTs: number;
  samples: Float32Array;
  sampleRate: number;
  /** Mean voice-activity probability of the speech frames in the clip. */
  speechConfidence: number;
  /** True when the clip hit audio.maxClipSeconds. */
  capped: boolean;
}

type Mode = 'idle' | 'recording' | 'cooldown';

function concat(chunks: readonly Float32Array[], limit: number): Float32Array {
  const total = Math.min(
    limit,
    chunks.reduce((n, c) => n + c.length, 0),
  );
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    // Past the limit this copies an empty slice; offset is clamped so set() stays in range.
    out.set(chunk.subarray(0, Math.max(0, total - offset)), Math.min(offset, total));
    offset += chunk.length;
  }
  return out;
}

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export class SpeechClipRecorder {
  private mode: Mode = 'idle';
  private preroll: AudioFrame[] = [];
  private prerollSamples = 0;
  private speechRunMs = 0;
  private runProbs: number[] = [];
  private runStartTs = 0;
  private chunks: Float32Array[] = [];
  private recorded = 0;
  private clipStartTs = 0;
  private speechStartTs = 0;
  private speechProbs: number[] = [];
  private silenceMs = 0;

  private readonly bufferSamples: number;
  private readonly maxSamples: number;

  constructor(
    private readonly policy: Policy,
    readonly sampleRate: number,
  ) {
    this.bufferSamples = Math.round(policy.audio.bufferSeconds * sampleRate);
    this.maxSamples = Math.round(policy.audio.maxClipSeconds * sampleRate);
  }

  /** True while audio is being kept for a clip (drives nothing visible; for tests/diagnostics). */
  get recording(): boolean {
    return this.mode === 'recording';
  }

  /** Feeds one frame. Returns a finished clip when one completes. */
  push(frame: AudioFrame): AudioClip | undefined {
    const { vadThreshold, minSpeechMs, silenceEndMs } = this.policy.audio;
    const speech = frame.speechProb >= vadThreshold;
    const frameMs = (frame.samples.length / this.sampleRate) * 1000;

    if (this.mode === 'cooldown') {
      this.silenceMs = speech ? 0 : this.silenceMs + frameMs;
      if (this.silenceMs >= silenceEndMs) this.reset();
      return undefined; // discarded: never buffered, never stored
    }

    if (this.mode === 'idle') {
      this.preroll.push(frame);
      this.prerollSamples += frame.samples.length;
      // Drop the oldest frames while the rest still cover the buffer (never empties: the
      // newest frame was just pushed).
      while (
        this.prerollSamples - (this.preroll[0] as AudioFrame).samples.length >=
        this.bufferSamples
      ) {
        this.prerollSamples -= (this.preroll.shift() as AudioFrame).samples.length;
      }
      if (!speech) {
        this.speechRunMs = 0;
        this.runProbs = [];
        return undefined;
      }
      if (this.speechRunMs === 0) this.runStartTs = frame.ts;
      this.speechRunMs += frameMs;
      this.runProbs.push(frame.speechProb);
      if (this.speechRunMs < minSpeechMs) return undefined;
      // Speech confirmed: the buffered audio becomes the start of the clip.
      this.mode = 'recording';
      this.chunks = this.preroll.map((f) => f.samples);
      this.recorded = this.prerollSamples;
      this.clipStartTs = (this.preroll[0] as AudioFrame).ts;
      this.speechStartTs = this.runStartTs;
      this.speechProbs = [...this.runProbs];
      this.silenceMs = 0;
      this.preroll = [];
      this.prerollSamples = 0;
      return this.recorded >= this.maxSamples ? this.finish(true) : undefined;
    }

    // recording
    this.chunks.push(frame.samples);
    this.recorded += frame.samples.length;
    if (speech) {
      this.silenceMs = 0;
      this.speechProbs.push(frame.speechProb);
    } else {
      this.silenceMs += frameMs;
    }
    if (this.recorded >= this.maxSamples) return this.finish(true);
    if (this.silenceMs >= silenceEndMs) return this.finish(false);
    return undefined;
  }

  /** Ends the session: completes a clip in progress, drops the in-memory buffer. */
  flush(): AudioClip | undefined {
    const clip = this.mode === 'recording' ? this.finish(false) : undefined;
    this.reset();
    return clip;
  }

  private finish(capped: boolean): AudioClip {
    const samples = concat(this.chunks, this.maxSamples);
    const clip: AudioClip = {
      startTs: this.clipStartTs,
      endTs: this.clipStartTs + (samples.length / this.sampleRate) * 1000,
      speechStartTs: this.speechStartTs,
      samples,
      sampleRate: this.sampleRate,
      speechConfidence: mean(this.speechProbs),
      capped,
    };
    this.reset();
    // After hitting the cap, wait for silence before anything can be recorded again.
    if (capped) this.mode = 'cooldown';
    return clip;
  }

  private reset(): void {
    this.mode = 'idle';
    this.preroll = [];
    this.prerollSamples = 0;
    this.speechRunMs = 0;
    this.runProbs = [];
    this.chunks = [];
    this.recorded = 0;
    this.speechProbs = [];
    this.silenceMs = 0;
  }
}

/** 16-bit PCM mono WAV (compact enough for the MVP; Opus can replace it later). */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] as number));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

/** Duration in seconds of a WAV produced by encodeWav. */
export function wavDurationSeconds(wav: Uint8Array): number {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  return view.getUint32(40, true) / view.getUint32(28, true);
}

// Multiple voices (FR4). Hard problem; isolated behind an interface so a proper speaker model
// can replace the heuristic. The shipped implementation is explicitly low-confidence.

export interface MultiVoiceResult {
  multiple: boolean;
  /** Never above policy.audio.multiVoice.maxConfidence for the heuristic. */
  confidence: number;
  /** Identifies the implementation, e.g. for reports and pilot calibration. */
  method: string;
}

export interface MultiVoiceDetector {
  readonly method: string;
  analyze(samples: Float32Array, sampleRate: number): MultiVoiceResult;
}

const PITCH_MIN_HZ = 70;
const PITCH_MAX_HZ = 400;
/** Normalised autocorrelation needed to call a frame voiced (signal-processing constant). */
const VOICED_CORRELATION = 0.6;
/** A period counts as the fundamental if it correlates within 10% of the best lag. */
const OCTAVE_TOLERANCE = 0.9;
const MIN_VOICED_FRAMES = 10;
const FRAME_SECONDS = 0.04;

/** Fundamental frequency of a voiced frame by autocorrelation, or undefined if unvoiced. */
export function estimatePitch(frame: Float32Array, sampleRate: number): number | undefined {
  let energy = 0;
  for (const s of frame) energy += s * s;
  if (energy / frame.length < 1e-6) return undefined;
  const minLag = Math.floor(sampleRate / PITCH_MAX_HZ);
  const maxLag = Math.min(Math.ceil(sampleRate / PITCH_MIN_HZ), frame.length - 1);
  const corr: number[] = [];
  let best = 0;
  let bestIdx = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0;
    let a = 0;
    let b = 0;
    for (let i = 0; i + lag < frame.length; i++) {
      const x = frame[i] as number;
      const y = frame[i + lag] as number;
      num += x * y;
      a += x * x;
      b += y * y;
    }
    const r = a > 0 && b > 0 ? num / Math.sqrt(a * b) : 0;
    if (r > best) {
      best = r;
      bestIdx = corr.length;
    }
    corr.push(r);
  }
  if (best < VOICED_CORRELATION) return undefined;
  // Octave-error guard: multiples of the true period correlate almost as well, so take the
  // shortest lag before the best that is a local peak within OCTAVE_TOLERANCE of it.
  let pick = bestIdx;
  for (let i = 0; i < bestIdx; i++) {
    const r = corr[i] as number;
    const isPeak = r >= (corr[i - 1] ?? -1) && r >= (corr[i + 1] as number);
    if (isPeak && r >= best * OCTAVE_TOLERANCE) {
      pick = i;
      break;
    }
  }
  return sampleRate / (minLag + pick);
}

const median = (sorted: readonly number[]) => {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

/**
 * Heuristic: split the voiced frames' pitches into a low and a high group at the point that
 * maximises the ratio of the groups' medians (each group holding >= minClusterShare). Two
 * clearly separated pitch groups suggest two speakers. Known weaknesses: expressive single
 * speakers, pitch-doubling errors, overlapping voices. Hence the capped confidence.
 */
export function createPitchClusterDetector(policy: Policy): MultiVoiceDetector {
  const { minPitchRatio, minClusterShare, maxConfidence } = policy.audio.multiVoice;
  const method = 'pitch-cluster-heuristic-v1';
  return {
    method,
    analyze(samples, sampleRate) {
      const size = Math.round(FRAME_SECONDS * sampleRate);
      const pitches: number[] = [];
      for (let start = 0; start + size <= samples.length; start += size) {
        const f0 = estimatePitch(samples.subarray(start, start + size), sampleRate);
        if (f0 !== undefined) pitches.push(f0);
      }
      const none = { multiple: false, confidence: 0, method };
      if (pitches.length < MIN_VOICED_FRAMES) return none;
      pitches.sort((a, b) => a - b);
      const minCount = Math.max(1, Math.ceil(pitches.length * minClusterShare));
      let bestRatio = 1;
      for (let split = minCount; split <= pitches.length - minCount; split++) {
        const ratio = median(pitches.slice(split)) / median(pitches.slice(0, split));
        if (ratio > bestRatio) bestRatio = ratio;
      }
      if (bestRatio < minPitchRatio) return none;
      // Half of maxConfidence at the threshold ratio, rising to maxConfidence at twice the margin.
      const confidence =
        maxConfidence * Math.min(1, 0.5 + (bestRatio - minPitchRatio) / (2 * (minPitchRatio - 1)));
      return { multiple: true, confidence, method };
    },
  };
}

/** Anomalies for a finished clip: speech_detected always, multiple_voices if indicated. */
export function clipAnomalies(
  clip: AudioClip,
  detector: MultiVoiceDetector,
  policy: Policy,
): DetectedAnomaly[] {
  const anomalies: DetectedAnomaly[] = [
    { type: 'speech_detected', ts: clip.speechStartTs, confidence: clip.speechConfidence },
  ];
  const voices = detector.analyze(clip.samples, clip.sampleRate);
  if (voices.multiple && voices.confidence >= policy.audio.multiVoice.minConfidence) {
    anomalies.push({
      type: 'multiple_voices',
      ts: clip.speechStartTs,
      confidence: voices.confidence,
    });
  }
  return anomalies;
}
