import { FACE_CROP_SIZE } from '@proctor/core';
import { describe, expect, it, vi } from 'vitest';
import { EMBEDDING_SIZE, FaceEmbedder, type EmbedderRuntime } from './face-embedder';

const CROP = new Float32Array(3 * FACE_CROP_SIZE * FACE_CROP_SIZE);

function runtime(output: ArrayLike<number> | undefined) {
  const r: EmbedderRuntime = {
    tensor: (type, data, dims) => ({ type, data, dims }),
    run: vi.fn(() => Promise.resolve(output ? { fc1: { data: output } } : {})),
  };
  return r;
}

describe('FaceEmbedder', () => {
  it('feeds the crop as a 1x3x112x112 tensor and returns the 128-number embedding', async () => {
    const r = runtime(new Float32Array(EMBEDDING_SIZE).fill(0.5));
    const embedding = await new FaceEmbedder(r).embed(CROP);
    expect(embedding).toHaveLength(EMBEDDING_SIZE);
    expect(embedding[0]).toBe(0.5);
    expect(r.run).toHaveBeenCalledWith({
      data: { type: 'float32', data: CROP, dims: [1, 3, 112, 112] },
    });
  });

  it('rejects a crop of the wrong size', async () => {
    await expect(new FaceEmbedder(runtime(undefined)).embed(new Float32Array(3))).rejects.toThrow(
      RangeError,
    );
  });

  it('rejects unexpected model output', async () => {
    await expect(new FaceEmbedder(runtime(undefined)).embed(CROP)).rejects.toThrow(/unexpected/);
    await expect(new FaceEmbedder(runtime([1, 2])).embed(CROP)).rejects.toThrow(/unexpected/);
  });
});
