import {
  FaceDetector,
  FaceLandmarker,
  FilesetResolver,
  ObjectDetector,
} from '@mediapipe/tasks-vision';
import { headPoseFromMatrix, type FrameObservation } from '@proctor/core';

// On-device models for webcam frames (MediaPipe Tasks Vision, bundled; never fetched at
// runtime). Face *detection* and head pose only: no recognition, no embeddings, nothing kept.

/**
 * Detectors return everything above this low floor so the rules in @proctor/core can see
 * sub-threshold scores (e.g. "no face" confidence = 1 - best face score). The policy's
 * video.minConfidence decides what counts.
 */
const DETECTION_FLOOR = 0.1;
const MAX_OBJECTS = 10;

export interface VisionModels {
  observe(image: ImageBitmap, ts: number): { observation: FrameObservation; inferenceMs: number };
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
      const observation: FrameObservation = {
        ts,
        faceScores: faceResult.detections.map((d) => d.categories[0]?.score ?? 0),
        objects: objectResult.detections.map((d) => ({
          category: d.categories[0]?.categoryName ?? '',
          score: d.categories[0]?.score ?? 0,
        })),
        ...(matrix ? { headPose: headPoseFromMatrix(Array.from(matrix)) } : {}),
      };
      return { observation, inferenceMs };
    },
    close() {
      faces.close();
      objects.close();
      landmarks.close();
    },
  };
}
