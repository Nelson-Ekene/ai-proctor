// Offscreen document (reason USER_MEDIA): owns the camera + microphone stream, because an MV3
// service worker cannot. Analyses both on the device:
// - Phase 4: samples webcam frames; only frames tied to an anomaly (plus a burst) are stored.
// - Phase 5: monitors the microphone continuously with Silero VAD; only clips of detected
//   speech are stored. Silence never leaves memory.
// Stored evidence waits for the Phase 6 upload queue. Nothing is uploaded from here.
import { createPitchClusterDetector, type Policy } from '@proctor/core';
import { openEvidenceDb, putClip, putFrame } from '../shared/evidence-store';
import { send } from '../shared/runtime';
import { VAD_SAMPLE_RATE, loadSileroVad } from '../shared/silero-vad';
import { loadVisionModels, type VisionModels } from '../shared/vision-models';
import { AudioMonitor } from './audio-monitor';
import { VideoSampler, type CapturedFrame } from './sampler';

/** Evidence JPEG quality: legible for a reviewer, small to upload. */
const EVIDENCE_JPEG_QUALITY = 0.8;

interface BitmapFrame extends CapturedFrame {
  bitmap: ImageBitmap;
}

interface CaptureContext {
  stream: MediaStream;
  policy: Policy;
  sessionId: string;
  db: IDBDatabase;
}

/** Logs locally and forwards to the service worker log (diagnostics; no media content). */
const warn = (message: string, error?: unknown) => {
  console.warn(`[proctor] ${message}`, error ?? '');
  const detail = error instanceof Error ? `: ${error.message}` : '';
  void send({ type: 'diag', message: `${message}${detail}`.slice(0, 500) }).catch(() => undefined);
};

/** Uniform [0, 1) from the CSPRNG, so sample times are unpredictable (FR1). */
function cryptoRng(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 2 ** 32;
}

async function openCamera(): Promise<MediaStream | undefined> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: true,
    });
  } catch (error) {
    warn('could not open camera/microphone', error);
    return undefined;
  }
}

async function startVideoSampling({ stream, policy, sessionId, db }: CaptureContext) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();

  let models: VisionModels;
  try {
    models = await loadVisionModels();
  } catch (error) {
    warn('vision models failed to load; video analysis disabled', error);
    return;
  }

  const sampler = new VideoSampler<BitmapFrame>({
    policy,
    now: () => Date.now(),
    rng: cryptoRng,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => {
      window.clearTimeout(id as number);
    },
    async grab() {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return undefined;
      const bitmap = await createImageBitmap(video);
      return {
        ts: Date.now(),
        bitmap,
        close: () => {
          bitmap.close();
        },
      };
    },
    analyze: (frame) => Promise.resolve(models.observe(frame.bitmap, frame.ts)),
    async persist(frame) {
      const canvas = new OffscreenCanvas(frame.bitmap.width, frame.bitmap.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2d context unavailable');
      ctx.drawImage(frame.bitmap, 0, 0);
      const blob = await canvas.convertToBlob({
        type: 'image/jpeg',
        quality: EVIDENCE_JPEG_QUALITY,
      });
      return putFrame(db, {
        id: crypto.randomUUID(),
        sessionId,
        ts: frame.ts,
        kind: 'frame',
        mime: blob.type,
        blob,
      });
    },
    report(anomalies) {
      void send({ type: 'video:anomalies', anomalies });
    },
    reportMeta(meta) {
      void send({ type: 'video:meta', meta });
    },
    log: warn,
  });
  sampler.start();
}

async function startAudioMonitoring({ stream, policy, sessionId, db }: CaptureContext) {
  let vad;
  try {
    vad = await loadSileroVad();
  } catch (error) {
    warn('voice activity model failed to load; audio analysis disabled', error);
    return;
  }

  // 16 kHz context: Chrome resamples the microphone to the rate Silero expects.
  const audio = new AudioContext({ sampleRate: VAD_SAMPLE_RATE });
  await audio.audioWorklet.addModule(chrome.runtime.getURL('worklets/pcm-capture.js'));
  const source = audio.createMediaStreamSource(stream);
  const capture = new AudioWorkletNode(audio, 'pcm-capture');
  // Keep the graph pulled without ever playing anything back.
  const mute = audio.createGain();
  mute.gain.value = 0;
  source.connect(capture).connect(mute).connect(audio.destination);

  const detector = createPitchClusterDetector(policy);
  const monitor = new AudioMonitor({
    policy,
    sampleRate: VAD_SAMPLE_RATE,
    vad,
    detector,
    onListening() {
      void send({
        type: 'audio:meta',
        meta: { listening: true, multiVoiceMethod: detector.method },
      });
    },
    async persist(clip, wav) {
      return putClip(db, {
        id: crypto.randomUUID(),
        sessionId,
        ts: clip.startTs,
        durationMs: clip.endTs - clip.startTs,
        kind: 'audio',
        mime: 'audio/wav',
        blob: new Blob([wav], { type: 'audio/wav' }),
      });
    },
    report(anomalies) {
      void send({ type: 'audio:anomalies', anomalies });
    },
    log: warn,
  });
  // Periodic counters in the diagnostics log (no audio content).
  window.setInterval(() => {
    warn(
      `audio stats: analysed=${String(monitor.framesAnalysed)} speech=${String(monitor.speechFrames)} clips=${String(monitor.clipsStored)} dropped=${String(monitor.dropped)} ctx=${audio.state}`,
    );
  }, 5000);
  const frameMs = (512 / VAD_SAMPLE_RATE) * 1000;
  capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
    // The frame just ended; stamp it with its start time.
    monitor.push(event.data, Date.now() - frameMs);
  };
}

async function start(): Promise<void> {
  const stream = await openCamera();
  if (!stream) {
    await send({ type: 'media:state', on: false });
    return;
  }
  for (const track of stream.getTracks()) {
    track.addEventListener('ended', () => {
      void send({ type: 'media:state', on: false });
    });
  }
  await send({ type: 'media:state', on: true });

  const config = await send({ type: 'video:config' });
  if (!config.ok || !config.policy || config.sessionId === undefined) {
    warn('analysis not started: no active session');
    return;
  }
  const ctx: CaptureContext = {
    stream,
    policy: config.policy,
    sessionId: config.sessionId,
    db: await openEvidenceDb(),
  };
  // Independent channels: one failing to start must not stop the other.
  await Promise.allSettled([startVideoSampling(ctx), startAudioMonitoring(ctx)]);
}

void start();
