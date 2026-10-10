import { describe, expect, it } from 'vitest';
import {
  SpeechClipRecorder,
  clipAnomalies,
  createPitchClusterDetector,
  encodeWav,
  estimatePitch,
  wavDurationSeconds,
  type AudioClip,
  type AudioFrame,
  type MultiVoiceDetector,
} from './audio';
import { DEFAULT_POLICY, parsePolicy, type Policy } from './policy';

const SR = 16_000;
const FRAME = 512; // 32 ms
const FRAME_MS = (FRAME / SR) * 1000;

/** Small numbers so tests run on a handful of frames. */
const QUICK: Policy = parsePolicy({
  ...DEFAULT_POLICY,
  audio: {
    ...DEFAULT_POLICY.audio,
    bufferSeconds: 0.32, // 10 frames
    maxClipSeconds: 1.6, // 50 frames
    minSpeechMs: 96, // 3 frames
    silenceEndMs: 320, // 10 frames
  },
});

function frames(probs: number[], startTs = 0): AudioFrame[] {
  return probs.map((p, i) => ({
    ts: startTs + i * FRAME_MS,
    samples: new Float32Array(FRAME).fill(p >= 0.5 ? 0.1 : 0.001),
    speechProb: p,
  }));
}

function run(recorder: SpeechClipRecorder, input: AudioFrame[]): AudioClip[] {
  const clips: AudioClip[] = [];
  for (const f of input) {
    const clip = recorder.push(f);
    if (clip) clips.push(clip);
  }
  return clips;
}

const silence = (n: number) => new Array<number>(n).fill(0.05);
const speech = (n: number, p = 0.9) => new Array<number>(n).fill(p);

describe('SpeechClipRecorder', () => {
  it('produces nothing while silent, however long', () => {
    const r = new SpeechClipRecorder(QUICK, SR);
    expect(run(r, frames(silence(2000)))).toEqual([]);
    expect(r.recording).toBe(false);
    expect(r.flush()).toBeUndefined();
  });

  it('ignores speech shorter than minSpeechMs (a cough)', () => {
    const r = new SpeechClipRecorder(QUICK, SR);
    expect(run(r, frames([...silence(20), ...speech(2), ...silence(50)]))).toEqual([]);
  });

  it('records buffer + speech until silence, stamped at speech start', () => {
    const r = new SpeechClipRecorder(QUICK, SR);
    const clips = run(r, frames([...silence(30), ...speech(20, 0.8), ...silence(15)]));
    expect(clips).toHaveLength(1);
    const [clip] = clips;
    // buffer of 10 frames (7 silent + first 3 speech frames at trigger) + 17 more speech + 10 silence
    expect(clip?.samples.length).toBe((10 + 17 + 10) * FRAME);
    expect(clip?.speechStartTs).toBeCloseTo(30 * FRAME_MS);
    expect(clip?.startTs).toBeCloseTo((30 + 3 - 10) * FRAME_MS);
    expect(clip?.endTs).toBeCloseTo((clip?.startTs ?? 0) + 37 * FRAME_MS);
    expect(clip?.speechConfidence).toBeCloseTo(0.8);
    expect(clip?.capped).toBe(false);
  });

  it('caps the clip at maxClipSeconds and then waits for silence before recording again', () => {
    const r = new SpeechClipRecorder(QUICK, SR);
    const clips = run(
      r,
      frames([
        ...speech(200),
        ...silence(5),
        ...speech(30),
        ...silence(12),
        ...speech(20),
        ...silence(12),
      ]),
    );
    // First clip capped at 50 frames; the rest of the long speech and the next burst (silence
    // gap of 5 < 10 frames) are discarded; after 12 silent frames recording is possible again.
    expect(clips).toHaveLength(2);
    expect(clips[0]?.samples.length).toBe(50 * FRAME);
    expect(clips[0]?.capped).toBe(true);
    expect(clips[1]?.capped).toBe(false);
    for (const c of clips) expect(c.samples.length).toBeLessThanOrEqual(50 * FRAME);
  });

  it('never exceeds 30 s with the default policy, even with continuous speech', () => {
    const r = new SpeechClipRecorder(DEFAULT_POLICY, SR);
    const clips = run(r, frames(speech(Math.ceil((120 * 1000) / FRAME_MS))));
    expect(clips).toHaveLength(1); // two minutes of talking -> one capped clip, not four
    expect(clips[0]?.samples.length).toBe(30 * SR);
    expect(clips[0]?.capped).toBe(true);
  });

  it('caps immediately if the buffer alone reaches the cap', () => {
    const tiny = parsePolicy({
      ...QUICK,
      audio: { ...QUICK.audio, bufferSeconds: 0.096, maxClipSeconds: 0.096 },
    });
    const clips = run(new SpeechClipRecorder(tiny, SR), frames(speech(3)));
    expect(clips).toHaveLength(1);
    expect(clips[0]?.capped).toBe(true);
    expect(clips[0]?.samples.length).toBe(3 * FRAME);
  });

  it('flush completes a clip in progress and drops the buffer', () => {
    const r = new SpeechClipRecorder(QUICK, SR);
    run(r, frames([...silence(5), ...speech(8)]));
    expect(r.recording).toBe(true);
    const clip = r.flush();
    expect(clip?.samples.length).toBe(13 * FRAME);
    expect(r.recording).toBe(false);
    expect(r.flush()).toBeUndefined();
  });

  it('a silence gap shorter than silenceEndMs keeps one clip', () => {
    const r = new SpeechClipRecorder(QUICK, SR);
    const clips = run(r, frames([...speech(5), ...silence(6), ...speech(5), ...silence(10)]));
    expect(clips).toHaveLength(1);
  });

  it('uses the policy VAD threshold', () => {
    const strict = parsePolicy({ ...QUICK, audio: { ...QUICK.audio, vadThreshold: 0.95 } });
    expect(
      run(new SpeechClipRecorder(strict, SR), frames([...speech(20, 0.9), ...silence(12)])),
    ).toEqual([]);
  });
});

describe('encodeWav', () => {
  it('writes a 16-bit mono PCM header and clamps samples', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]), SR);
    const view = new DataView(wav.buffer);
    const text = (o: number, n: number) => String.fromCharCode(...wav.slice(o, o + n));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(text(36, 4)).toBe('data');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(SR);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(12);
    expect([1, 2, 3, 4, 5].map((i) => view.getInt16(44 + i * 2, true))).toEqual([
      32767, -32768, 32767, -32768, 16383,
    ]);
    expect(wavDurationSeconds(wav)).toBeCloseTo(6 / SR);
  });

  it('encodes a 30 s clip as 30 s', () => {
    expect(wavDurationSeconds(encodeWav(new Float32Array(30 * SR), SR))).toBe(30);
  });
});

/** Deterministic pseudo-noise. */
function noise(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/** A crude "voice": harmonics of f0 plus a little noise. */
function voice(f0: number, seconds: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  const n = noise(seed);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    out[i] =
      0.5 * Math.sin(2 * Math.PI * f0 * t) +
      0.25 * Math.sin(2 * Math.PI * 2 * f0 * t) +
      0.1 * Math.sin(2 * Math.PI * 3 * f0 * t) +
      0.02 * n();
  }
  return out;
}

function join(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('estimatePitch', () => {
  it('finds the fundamental of a voiced frame', () => {
    expect(estimatePitch(voice(150, 0.04), SR)).toBeGreaterThan(145);
    expect(estimatePitch(voice(150, 0.04), SR)).toBeLessThan(155);
    expect(estimatePitch(voice(230, 0.04), SR)).toBeGreaterThan(222);
  });

  it('copes with a frame whose energy sits only at its very end', () => {
    const frame = new Float32Array(640);
    frame.fill(0.5, 600);
    // Long lags compare an all-zero window: those correlations are 0 rather than NaN.
    expect(estimatePitch(frame, SR)).toBeUndefined();
  });

  it('returns undefined for silence and for noise', () => {
    expect(estimatePitch(new Float32Array(640), SR)).toBeUndefined();
    const n = noise(7);
    expect(
      estimatePitch(
        Float32Array.from({ length: 640 }, () => n()),
        SR,
      ),
    ).toBeUndefined();
  });
});

describe('pitch-cluster multiple-voice heuristic', () => {
  const detector = createPitchClusterDetector(DEFAULT_POLICY);

  it('labels itself and stays below its confidence cap', () => {
    const r = detector.analyze(join(voice(110, 2), voice(210, 2, 2)), SR);
    expect(r.method).toBe('pitch-cluster-heuristic-v1');
    expect(r.multiple).toBe(true);
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(DEFAULT_POLICY.audio.multiVoice.maxConfidence);
  });

  it('does not flag one steady voice, a small pitch drift, or too little voiced audio', () => {
    expect(detector.analyze(voice(150, 4), SR).multiple).toBe(false);
    expect(detector.analyze(join(voice(140, 2), voice(160, 2, 3)), SR).multiple).toBe(false);
    expect(detector.analyze(voice(150, 0.2), SR)).toEqual({
      multiple: false,
      confidence: 0,
      method: 'pitch-cluster-heuristic-v1',
    });
  });

  it('skips unvoiced frames (pauses between words)', () => {
    const r = detector.analyze(join(voice(150, 1.5), new Float32Array(SR), voice(150, 1.5, 8)), SR);
    expect(r.multiple).toBe(false);
  });

  it('does not flag two voices of similar pitch (documented limitation)', () => {
    expect(detector.analyze(join(voice(120, 2), voice(200, 2, 6)), SR).multiple).toBe(false);
  });

  it('needs both pitch groups to be substantial (minClusterShare)', () => {
    // 95% one voice, 5% another: below the 25% share -> not flagged
    expect(detector.analyze(join(voice(120, 3.8), voice(220, 0.2, 4)), SR).multiple).toBe(false);
  });

  it('reaches the cap for very separated voices', () => {
    const r = detector.analyze(join(voice(90, 2), voice(260, 2, 5)), SR);
    expect(r.confidence).toBeCloseTo(DEFAULT_POLICY.audio.multiVoice.maxConfidence);
  });
});

describe('clipAnomalies', () => {
  const clip: AudioClip = {
    startTs: 1000,
    endTs: 4000,
    speechStartTs: 1500,
    samples: new Float32Array(10),
    sampleRate: SR,
    speechConfidence: 0.83,
    capped: false,
  };
  const fixed = (multiple: boolean, confidence: number): MultiVoiceDetector => ({
    method: 'fixed',
    analyze: () => ({ multiple, confidence, method: 'fixed' }),
  });

  it('always raises speech_detected at the speech start with the VAD confidence', () => {
    expect(clipAnomalies(clip, fixed(false, 0), DEFAULT_POLICY)).toEqual([
      { type: 'speech_detected', ts: 1500, confidence: 0.83 },
    ]);
  });

  it('adds multiple_voices only above the policy minimum', () => {
    expect(clipAnomalies(clip, fixed(true, 0.45), DEFAULT_POLICY).map((a) => a.type)).toEqual([
      'speech_detected',
      'multiple_voices',
    ]);
    expect(clipAnomalies(clip, fixed(true, 0.2), DEFAULT_POLICY)).toHaveLength(1);
  });
});
