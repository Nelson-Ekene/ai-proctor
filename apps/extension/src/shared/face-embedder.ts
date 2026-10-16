import { FACE_CROP_SIZE } from '@proctor/core';

// Face embedding model for optional face matching (Phase 11, policy.faceMatch): SFace
// (OpenCV Zoo, Apache-2.0), bundled and run on the device with onnxruntime-web. Turns an aligned
// 112x112 face crop into a 128-number embedding. Embeddings stay in the offscreen document's
// memory: they are never stored, sent to the service worker or uploaded.

/** Model contract (verified against face_recognition_sface_2021dec.onnx). */
const INPUT = 'data';
const OUTPUT = 'fc1';
export const EMBEDDING_SIZE = 128;

interface TensorLike {
  data: ArrayLike<number | bigint | string>;
}

/** The slice of onnxruntime-web this wrapper needs (injectable for tests). */
export interface EmbedderRuntime {
  run(feeds: Record<string, unknown>): Promise<Record<string, TensorLike>>;
  tensor(type: 'float32', data: Float32Array, dims: readonly number[]): unknown;
}

export class FaceEmbedder {
  constructor(private readonly runtime: EmbedderRuntime) {}

  /** Embedding of one aligned face (alignFace output: RGB planes, 0-255). */
  async embed(crop: Float32Array): Promise<Float32Array> {
    if (crop.length !== 3 * FACE_CROP_SIZE * FACE_CROP_SIZE) {
      throw new RangeError('expected a 3x112x112 face crop');
    }
    const out = await this.runtime.run({
      [INPUT]: this.runtime.tensor('float32', crop, [1, 3, FACE_CROP_SIZE, FACE_CROP_SIZE]),
    });
    const data = out[OUTPUT]?.data;
    if (data?.length !== EMBEDDING_SIZE) throw new Error('unexpected embedding model output');
    return Float32Array.from(data, Number);
  }
}

/** Loads the bundled model with the bundled wasm runtime (no network access). */
export async function loadFaceEmbedder(): Promise<FaceEmbedder> {
  const ort = await import('onnxruntime-web/wasm');
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/onnx/');
  // Threads need cross-origin isolation, which extension documents do not have.
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(
    chrome.runtime.getURL('vendor/models/face_recognition_sface_2021dec.onnx'),
    // The converted model lists its weights as graph inputs; ORT warns about each one.
    { executionProviders: ['wasm'], logSeverityLevel: 3 },
  );
  return new FaceEmbedder({
    run: (feeds) => session.run(feeds as Record<string, InstanceType<typeof ort.Tensor>>),
    tensor: (type, data, dims) => new ort.Tensor(type, data, dims),
  });
}
