import {
  SpeechClipRecorder,
  clipAnomalies,
  encodeWav,
  type AudioClip,
  type EvidenceRef,
  type MultiVoiceDetector,
  type PendingAnomaly,
  type Policy,
} from '@proctor/core';

// Continuous on-device microphone monitoring (FR3, FR4). Every 32 ms frame gets a voice-activity
// probability; the core recorder decides when a clip exists. Silence never leaves memory, and
// only a finished clip is encoded, stored and linked to its anomalies.

export interface AudioMonitorDeps {
  policy: Policy;
  sampleRate: number;
  vad: { probability(frame: Float32Array): Promise<number> };
  detector: MultiVoiceDetector;
  /** Stores an encoded clip as evidence. Only ever called for clips (speech). */
  persist(clip: AudioClip, wav: Uint8Array<ArrayBuffer>): Promise<EvidenceRef>;
  report(anomalies: PendingAnomaly[]): void;
  /** Called once, after the first frame has been analysed: the monitor is really listening. */
  onListening?(): void;
  log?(message: string, error?: unknown): void;
}

/**
 * Frames waiting for VAD beyond this are dropped (the model normally runs ~15x faster than real
 * time); keeps memory bounded on a stalled device instead of queueing audio indefinitely.
 */
const MAX_PENDING_FRAMES = 64;

export class AudioMonitor {
  private readonly recorder: SpeechClipRecorder;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private stopped = false;
  private listening = false;
  /** Diagnostics counters (no audio content). */
  dropped = 0;
  framesAnalysed = 0;
  speechFrames = 0;
  clipsStored = 0;

  constructor(private readonly deps: AudioMonitorDeps) {
    this.recorder = new SpeechClipRecorder(deps.policy, deps.sampleRate);
  }

  /** Feeds one frame (start time ts). Processing is sequential and asynchronous. */
  push(samples: Float32Array, ts: number): void {
    if (this.stopped) return;
    if (this.pending >= MAX_PENDING_FRAMES) {
      this.dropped += 1;
      return;
    }
    this.pending += 1;
    this.queue = this.queue
      .then(() => this.process(samples, ts))
      .catch((error: unknown) => this.deps.log?.('audio frame failed', error))
      .finally(() => {
        this.pending -= 1;
      });
  }

  /** Resolves when queued frames are processed (tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  /** Stops listening; completes a clip in progress so the speech is not lost. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.queue;
    const clip = this.recorder.flush();
    if (clip) await this.handle(clip);
  }

  private async process(samples: Float32Array, ts: number): Promise<void> {
    const speechProb = await this.deps.vad.probability(samples);
    this.framesAnalysed += 1;
    if (speechProb >= this.deps.policy.audio.vadThreshold) this.speechFrames += 1;
    if (!this.listening) {
      this.listening = true;
      this.deps.onListening?.();
    }
    const clip = this.recorder.push({ ts, samples, speechProb });
    if (clip) await this.handle(clip);
  }

  private async handle(clip: AudioClip): Promise<void> {
    const evidence = await this.deps.persist(clip, encodeWav(clip.samples, clip.sampleRate));
    this.clipsStored += 1;
    const anomalies = clipAnomalies(clip, this.deps.detector, this.deps.policy);
    this.deps.report(anomalies.map((a) => ({ ...a, evidence: [evidence] })));
  }
}
