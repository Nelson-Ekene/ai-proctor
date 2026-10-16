import {
  FaceDetector,
  FaceLandmarker,
  FilesetResolver,
  ObjectDetector,
} from '@mediapipe/tasks-vision';
import { alignFace, headPoseFromMatrix, type FrameObservation, type Point } from '@proctor/core';

// On-device models for webcam frames (MediaPipe Tasks Vision, bundled; never fetched at
// runtime). Face detection and head pose. The only face geometry that leaves this wrapper is the
// detector's eye/nose/mouth keypoints of the most prominent face, used solely to align a crop
// for optional face matching (face-embedder.ts); nothing here is kept.

/**
 * Detectors return everything above this low floor so the rules in @proctor/core can see
 * sub-threshold scores (e.g. "no face" confidence = 1 - best face score). The policy's
 * video.minConfidence decides what counts.
 */
const DETECTION_FLOOR = 0.1;
const MAX_OBJECTS = 10;
/** BlazeFace keypoint order: eyes, nose tip, mouth centre, then the two ear tragions. */
const ALIGN_KEYPOINTS = 4;

export interface Observed {
  observation: FrameObservation;
  inferenceMs: number;
  /** Eyes, nose tip and mouth centre of the highest-scoring face, in pixels. */
  faceKeypoints?: Point[];
}

export interface VisionModels {
  observe(image: ImageBitmap, ts: number): Observed;
  close(): void;
}

export async function loadVisionModels(): Promise<VisionModels> {
  const fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('vendor/mediapipe'));
  const model = (file: string) => ({
    modelAssetPath: chrome.runtime.getURL(`vendor/models/${file}`),
    delegate: 'CPU' as const,
  });
  const [faces, objects, landmarks] = await Promise.all([
    FaceDetector.createFromOptions(fileset, {
      baseOptions: model('blaze_face_short_range.tflite'),
      runningMode: 'IMAGE',
      minDetectionConfidence: DETECTION_FLOOR,
    }),
    ObjectDetector.createFromOptions(fileset, {
      baseOptions: model('efficientdet_lite0.tflite'),
      runningMode: 'IMAGE',
      scoreThreshold: DETECTION_FLOOR,
      maxResults: MAX_OBJECTS,
    }),
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: model('face_landmarker.task'),
      runningMode: 'IMAGE',
      numFaces: 1,
      outputFacialTransformationMatrixes: true,
    }),
  ]);

  return {
    observe(image, ts) {
      const start = performance.now();
      const faceResult = faces.detect(image);
      const objectResult = objects.detect(image);
      const landmarkResult = landmarks.detect(image);
      const inferenceMs = performance.now() - start;
      const matrix = landmarkResult.facialTransformationMatrixes[0]?.data;
      const scoreOf = (d: (typeof faceResult.detections)[number]) => d.categories[0]?.score ?? 0;
      const best = [...faceResult.detections].sort((a, b) => scoreOf(b) - scoreOf(a))[0];
      const keypoints = best?.keypoints.slice(0, ALIGN_KEYPOINTS) ?? [];
      const observation: FrameObservation = {
        ts,
        faceScores: faceResult.detections.map(scoreOf),
        objects: objectResult.detections.map((d) => ({
          category: d.categories[0]?.categoryName ?? '',
          score: d.categories[0]?.score ?? 0,
        })),
        ...(matrix ? { headPose: headPoseFromMatrix(Array.from(matrix)) } : {}),
      };
      return {
        observation,
        inferenceMs,
        ...(keypoints.length === ALIGN_KEYPOINTS
          ? {
              faceKeypoints: keypoints.map((k) => ({
                x: k.x * image.width,
                y: k.y * image.height,
              })),
            }
          : {}),
      };
    },
    close() {
      faces.close();
      objects.close();
      landmarks.close();
    },
  };
}

/** The face as the embedding model expects it (core alignFace on the frame's pixels). */
export function alignedFaceCrop(image: ImageBitmap, keypoints: readonly Point[]): Float32Array {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d context unavailable');
  ctx.drawImage(image, 0, 0);
  return alignFace(ctx.getImageData(0, 0, image.width, image.height), keypoints);
}
