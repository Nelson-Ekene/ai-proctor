import {
  analyzeFrame,
  cosineSimilarity,
  DEFAULT_POLICY,
  singleFaceScore,
  type FrameAnalysis,
  type FrameObservation,
} from '@proctor/core';
import { loadFaceEmbedder } from '../shared/face-embedder';
import { alignedFaceCrop, loadVisionModels } from '../shared/vision-models';

// Development-only page for the fairness harnesses (e2e/fairness): runs the exact bundled models
// and core frame rules on test images. Built only with PROCTOR_DIAGNOSTICS=1; the release check
// refuses any package that contains it. Images are analysed in memory and never stored; face
// comparisons return similarities only, never embeddings.

export interface DiagnosticsResult {
  observation: FrameObservation;
  analysis: FrameAnalysis;
  inferenceMs: number;
}

declare global {
  interface Window {
    proctorDiagnostics?: {
      analyse(imageUrl: string): Promise<DiagnosticsResult>;
      /**
       * Face-matching similarity of every probe to every reference (rows = references), or null
       * where an image did not show exactly one confident, alignable face.
       */
      compareFaces(references: string[], probes: string[]): Promise<(number | null)[][]>;
    };
  }
}

const [models, embedder] = await Promise.all([loadVisionModels(), loadFaceEmbedder()]);

async function bitmapOf(imageUrl: string): Promise<ImageBitmap> {
  return createImageBitmap(await (await fetch(imageUrl)).blob());
}

/** The production path: single confident face, detector keypoints, aligned crop, embedding. */
async function embeddingOf(imageUrl: string): Promise<Float32Array | undefined> {
  const bitmap = await bitmapOf(imageUrl);
  try {
    const { observation, faceKeypoints } = models.observe(bitmap, Date.now());
    if (singleFaceScore(observation.faceScores, DEFAULT_POLICY) === undefined) return undefined;
    if (!faceKeypoints) return undefined;
    return await embedder.embed(alignedFaceCrop(bitmap, faceKeypoints));
  } finally {
    bitmap.close();
  }
}

window.proctorDiagnostics = {
  async analyse(imageUrl) {
    const bitmap = await bitmapOf(imageUrl);
    try {
      const { observation, inferenceMs } = models.observe(bitmap, Date.now());
      return { observation, analysis: analyzeFrame(observation, DEFAULT_POLICY), inferenceMs };
    } finally {
      bitmap.close();
    }
  },
  async compareFaces(references, probes) {
    const refs: (Float32Array | undefined)[] = [];
    for (const url of references) refs.push(await embeddingOf(url));
    const prs: (Float32Array | undefined)[] = [];
    for (const url of probes) prs.push(await embeddingOf(url));
    return refs.map((r) => prs.map((p) => (r && p ? cosineSimilarity(r, p) : null)));
  },
};
document.title = 'Hawkeye: model diagnostics (ready)';
