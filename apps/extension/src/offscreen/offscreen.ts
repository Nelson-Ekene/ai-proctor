// Offscreen document (reason USER_MEDIA): owns the camera + microphone stream, because an MV3
// service worker cannot. Phase 4: samples webcam frames and analyses them on the device.
// Only frames tied to an anomaly (plus a short burst) are stored, for the Phase 6 upload queue.
// Audio analysis arrives in Phase 5. Nothing is uploaded from here.
import { send } from '../shared/runtime';
import { openEvidenceDb, putFrame } from '../shared/evidence-store';
import { loadVisionModels, type VisionModels } from '../shared/vision-models';
import { VideoSampler, type CapturedFrame } from './sampler';

/** Evidence JPEG quality: legible for a reviewer, small to upload. */
const EVIDENCE_JPEG_QUALITY = 0.8;

interface BitmapFrame extends CapturedFrame {
  bitmap: ImageBitmap;
}

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
    console.warn('[proctor] could not open camera/microphone', error);
    return undefined;
  }
}

async function startVideoSampling(stream: MediaStream): Promise<void> {
  const config = await send({ type: 'video:config' });
  if (!config.ok || !config.policy || config.sessionId === undefined) {
    console.warn('[proctor] video sampling not started: no active session');
    return;
  }
  const { policy, sessionId } = config;

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();

  let models: VisionModels;
  try {
    models = await loadVisionModels();
  } catch (error) {
    console.error('[proctor] vision models failed to load; video analysis disabled', error);
    return;
  }
  const db = await openEvidenceDb();

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
    log: (message, error) => {
      console.warn(`[proctor] ${message}`, error);
    },
  });
  sampler.start();
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
  await startVideoSampling(stream);
}

void start();
