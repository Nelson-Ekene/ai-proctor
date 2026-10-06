import type { Policy } from '@proctor/core';
import { createFaceCounter, type FaceCounter } from '../shared/face-detector';
import { el, send } from '../shared/runtime';
import {
  evaluateSetup,
  rms,
  type CheckOutcome,
  type SetupEvaluation,
  type SetupMeasurements,
} from './setup-checks';

/** UI refresh cadence while measuring (not a proctoring sampling rate). */
const MEASURE_INTERVAL_MS = 200;

const app = document.getElementById('app') as HTMLElement;

const CHECKS = [
  ['face', 'Face visible'],
  ['mic', 'Microphone'],
  ['performance', 'Device performance'],
] as const;

function statusLabel(outcome: CheckOutcome | undefined): string {
  if (!outcome) return 'Not checked yet';
  return outcome.status === 'ready' ? 'Ready' : 'Needs attention';
}

async function measure(
  video: HTMLVideoElement,
  stream: MediaStream,
  policy: Policy,
): Promise<SetupMeasurements> {
  const audio = new AudioContext();
  const analyser = audio.createAnalyser();
  analyser.fftSize = 2048;
  audio.createMediaStreamSource(stream).connect(analyser);
  const buffer = new Float32Array(analyser.fftSize);

  let detector: FaceCounter | undefined;
  try {
    detector = await createFaceCounter();
  } catch (error) {
    console.warn('[proctor] face model unavailable', error);
  }

  const m: SetupMeasurements = {
    faceCounts: [],
    micLevels: [],
    inferenceMs: [],
    modelLoaded: detector !== undefined,
  };
  const end = performance.now() + policy.setupCheck.sampleSeconds * 1000;
  while (performance.now() < end) {
    analyser.getFloatTimeDomainData(buffer);
    m.micLevels.push(rms(buffer));
    if (detector && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const t0 = performance.now();
      m.faceCounts.push(detector.count(video, t0));
      m.inferenceMs.push(performance.now() - t0);
    }
    await new Promise((resolve) => setTimeout(resolve, MEASURE_INTERVAL_MS));
  }
  detector?.close();
  await audio.close();
  return m;
}

async function main(): Promise<void> {
  const response = await send({ type: 'setup:get' });
  if (!response.ok || !response.policy) {
    app.replaceChildren(
      el('h1', { text: 'This setup check is no longer active' }),
      el('p', { className: 'muted', text: 'You can close this tab and return to your exam page.' }),
    );
    return;
  }
  const policy = response.policy;

  const video = el('video', { id: 'preview' });
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;

  const rows = new Map<string, { status: HTMLElement; message: HTMLElement }>();
  const list = el(
    'ul',
    { className: 'checks' },
    ...CHECKS.map(([key, title]) => {
      const status = el('span', { className: 'status-pending', text: statusLabel(undefined) });
      status.dataset.check = key;
      const message = el('div', { className: 'muted' });
      rows.set(key, { status, message });
      return el(
        'li',
        { className: 'check' },
        el('div', {}, el('strong', { text: title }), message),
        status,
      );
    }),
  );

  const start = el('button', { text: 'Start check', className: 'primary', id: 'start-check' });
  const proceed = el('button', { text: 'Continue to exam', id: 'continue' });
  proceed.disabled = true;
  const note = el('p', { className: 'muted', id: 'note' });
  const error = el('p', { className: 'error', id: 'error' });
  error.hidden = true;

  let stream: MediaStream | undefined;
  let evaluation: SetupEvaluation | undefined;

  const render = (e: SetupEvaluation) => {
    for (const [key] of CHECKS) {
      const row = rows.get(key);
      if (!row) continue;
      row.status.textContent = statusLabel(e[key]);
      row.status.className = `status-${e[key].status}`;
      row.message.textContent = e[key].message;
    }
    const allReady = Object.values(e.result).every((s) => s === 'ready');
    note.textContent = allReady
      ? 'Everything looks good.'
      : 'You can continue, but fixing the items above helps the reviewer see clear evidence.';
  };

  start.addEventListener('click', () => {
    void (async () => {
      start.disabled = proceed.disabled = true;
      error.hidden = true;
      try {
        stream ??= await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch {
        error.textContent =
          'Camera and microphone access is needed. Allow access in the browser prompt or site settings, then try again.';
        error.hidden = false;
        start.disabled = false;
        return;
      }
      video.srcObject = stream;
      note.textContent = 'Checking… look at the camera and say a few words.';
      evaluation = evaluateSetup(await measure(video, stream, policy), policy);
      render(evaluation);
      start.textContent = 'Run again';
      start.disabled = false;
      proceed.disabled = false;
    })();
  });

  proceed.addEventListener('click', () => {
    if (!evaluation) return;
    const result = evaluation.result;
    void (async () => {
      start.disabled = proceed.disabled = true;
      // Release the preview; the background capture opens its own stream.
      stream?.getTracks().forEach((t) => {
        t.stop();
      });
      stream = undefined;
      const res = await send({ type: 'setup:complete', result });
      if (!res.ok) {
        error.textContent = 'Something went wrong starting the session. Please try again.';
        error.hidden = false;
        start.disabled = false;
      }
    })();
  });

  app.replaceChildren(
    el('h1', { text: 'Quick setup check' }),
    el('p', {
      text: 'This checks that your camera, microphone and device are working. It is not part of your exam result.',
    }),
    video,
    list,
    note,
    el('div', { className: 'actions' }, start, proceed),
    error,
  );
}

void main();
