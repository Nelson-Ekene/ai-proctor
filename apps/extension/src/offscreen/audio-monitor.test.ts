import {
  DEFAULT_POLICY,
  parsePolicy,
  wavDurationSeconds,
  type EvidenceRef,
  type MultiVoiceDetector,
  type PendingAnomaly,
} from '@proctor/core';
import { describe, expect, it } from 'vitest';
import { AudioMonitor } from './audio-monitor';

const SR = 16_000;
const FRAME = 512;
const FRAME_MS = 32;

const POLICY = parsePolicy({
  ...DEFAULT_POLICY,
  audio: {
    ...DEFAULT_POLICY.audio,
    bufferSeconds: 0.32,
    maxClipSeconds: 1.6,
    minSpeechMs: 96,
    silenceEndMs: 320,
  },
});

const singleVoice: MultiVoiceDetector = {
  method: 'test',
  analyze: () => ({ multiple: false, confidence: 0, method: 'test' }),
};

function harness(probs: number[], detector = singleVoice) {
  let i = 0;
  const persisted: { seconds: number; bytes: number }[] = [];
  const reports: PendingAnomaly[][] = [];
  const monitor = new AudioMonitor({
    policy: POLICY,
    sampleRate: SR,
    vad: { probability: () => Promise.resolve(probs[i++] ?? 0) },
    detector,
    persist: (clip, wav): Promise<EvidenceRef> => {
      persisted.push({ seconds: wavDurationSeconds(wav), bytes: wav.length });
      return Promise.resolve({
        id: `clip${String(persisted.length)}`,
        kind: 'audio',
        ts: clip.startTs,
      });
    },
    report: (a) => reports.push(a),
  });
  const feed = (n: number) => {
    for (let k = 0; k < n; k++) monitor.push(new Float32Array(FRAME).fill(0.01), k * FRAME_MS);
  };
  return { monitor, persisted, reports, feed };
}

describe('AudioMonitor', () => {
  it('stores and reports nothing while silent', async () => {
    const h = harness(new Array<number>(500).fill(0.05));
    h.feed(500);
    await h.monitor.stop();
    expect(h.persisted).toEqual([]);
    expect(h.reports).toEqual([]);
  });

  it('turns speech into one WAV clip linked to speech_detected', async () => {
    const h = harness([
      ...new Array<number>(20).fill(0.05),
      ...new Array<number>(20).fill(0.9),
      ...new Array<number>(15).fill(0.05),
    ]);
    h.feed(55);
    await h.monitor.idle();
    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]?.seconds).toBeCloseTo((37 * FRAME) / SR);
    expect(h.reports).toEqual([
      [
        {
          type: 'speech_detected',
          ts: 20 * FRAME_MS,
          confidence: expect.closeTo(0.9, 5) as number,
          evidence: [{ id: 'clip1', kind: 'audio', ts: 13 * FRAME_MS }],
        },
      ],
    ]);
  });

  it('never stores a clip longer than audio.maxClipSeconds', async () => {
    const h = harness(new Array<number>(400).fill(0.95));
    h.feed(400);
    await h.monitor.stop();
    expect(h.persisted.length).toBeGreaterThan(0);
    for (const p of h.persisted) expect(p.seconds).toBeLessThanOrEqual(1.6);
  });

  it('adds multiple_voices with the same clip as evidence when the detector says so', async () => {
    const two: MultiVoiceDetector = {
      method: 'test',
      analyze: () => ({ multiple: true, confidence: 0.5, method: 'test' }),
    };
    const h = harness(
      [...new Array<number>(20).fill(0.9), ...new Array<number>(12).fill(0.05)],
      two,
    );
    h.feed(32);
    await h.monitor.idle();
    expect(h.reports[0]?.map((a) => a.type)).toEqual(['speech_detected', 'multiple_voices']);
    expect(h.reports[0]?.[1]?.evidence).toEqual(h.reports[0]?.[0]?.evidence);
  });

  it('completes a clip in progress when stopped, then ignores further frames', async () => {
    const h = harness(new Array<number>(30).fill(0.9));
    h.feed(10);
    await h.monitor.stop();
    expect(h.persisted).toHaveLength(1);
    h.feed(30);
    await h.monitor.idle();
    expect(h.persisted).toHaveLength(1);
  });

  it('drops frames instead of queueing without bound when VAD stalls', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const monitor = new AudioMonitor({
      policy: POLICY,
      sampleRate: SR,
      vad: { probability: () => gate.then(() => 0) },
      detector: singleVoice,
      persist: () => Promise.reject(new Error('unused')),
      report: () => undefined,
    });
    for (let k = 0; k < 100; k++) monitor.push(new Float32Array(FRAME), k);
    expect(monitor.dropped).toBe(36);
    release();
    await monitor.idle();
  });

  it('reports once that it is listening, after the first analysed frame', async () => {
    let listening = 0;
    const monitor = new AudioMonitor({
      policy: POLICY,
      sampleRate: SR,
      vad: { probability: () => Promise.resolve(0) },
      detector: singleVoice,
      persist: () => Promise.reject(new Error('unused')),
      report: () => undefined,
      onListening: () => {
        listening += 1;
      },
    });
    expect(listening).toBe(0);
    for (let k = 0; k < 5; k++) monitor.push(new Float32Array(FRAME), k);
    await monitor.idle();
    expect(listening).toBe(1);
  });

  it('logs and continues when a frame fails', async () => {
    const errors: unknown[] = [];
    let n = 0;
    const monitor = new AudioMonitor({
      policy: POLICY,
      sampleRate: SR,
      vad: {
        probability: () =>
          n++ === 0 ? Promise.reject(new Error('vad crashed')) : Promise.resolve(0),
      },
      detector: singleVoice,
      persist: () => Promise.reject(new Error('unused')),
      report: () => undefined,
      log: (_m, e) => errors.push(e),
    });
    monitor.push(new Float32Array(FRAME), 0);
    monitor.push(new Float32Array(FRAME), 32);
    await monitor.idle();
    expect(errors).toHaveLength(1);
    expect(n).toBe(2);
  });
});
