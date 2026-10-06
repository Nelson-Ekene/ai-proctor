// Offscreen document (reason USER_MEDIA): owns the camera + microphone stream, because an MV3
// service worker cannot. Phase 2 only opens the stream and reports its state; sampling and
// analysis arrive in Phases 4 and 5. Nothing is recorded or uploaded here.
import { send } from '../shared/runtime';

let stream: MediaStream | undefined;

async function start(): Promise<void> {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: true,
    });
  } catch (error) {
    console.warn('[proctor] could not open camera/microphone', error);
    await send({ type: 'media:state', on: false });
    return;
  }
  for (const track of stream.getTracks()) {
    track.addEventListener('ended', () => {
      void send({ type: 'media:state', on: false });
    });
  }
  await send({ type: 'media:state', on: true });
}

void start();
