import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';

// On-device face *detection* (counting faces). No recognition, no embeddings, nothing stored.
// Wasm runtime and model are bundled with the extension; nothing is fetched at runtime.

export interface FaceCounter {
  count(video: HTMLVideoElement, timestampMs: number): number;
  close(): void;
}

export async function createFaceCounter(): Promise<FaceCounter> {
  const fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('vendor/mediapipe'));
  const detector = await FaceDetector.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: chrome.runtime.getURL('vendor/models/blaze_face_short_range.tflite'),
      delegate: 'CPU',
    },
    runningMode: 'VIDEO',
  });
  return {
    count: (video, timestampMs) => detector.detectForVideo(video, timestampMs).detections.length,
    close: () => {
      detector.close();
    },
  };
}
