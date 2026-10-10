import { describe, expect, it, vi } from 'vitest';
import { SileroVad, VAD_FRAME, type VadRuntime } from './silero-vad';

function fakeRuntime(probs: number[]) {
  const calls: Record<string, unknown>[] = [];
  let i = 0;
  const runtime: VadRuntime = {
    tensor: (type, data, dims) => ({ type, data, dims }),
    run: vi.fn((feeds: Record<string, unknown>) => {
      calls.push(feeds);
      const p = probs[i++] ?? 0;
      return Promise.resolve({
        output: { data: new Float32Array([p]) },
        stateN: { data: new Float32Array(256).fill(i) },
      });
    }),
  };
  return { runtime, calls };
}

const frameOf = (value: number) => new Float32Array(VAD_FRAME).fill(value);
type Feed = { data: Float32Array; dims: number[] };

describe('SileroVad', () => {
  it('returns the model probability per frame', async () => {
    const { runtime } = fakeRuntime([0.1, 0.9]);
    const vad = new SileroVad(runtime);
    expect(await vad.probability(frameOf(0))).toBeCloseTo(0.1);
    expect(await vad.probability(frameOf(0))).toBeCloseTo(0.9);
  });

  it('prepends the previous frame tail (64 samples) and carries the recurrent state', async () => {
    const { runtime, calls } = fakeRuntime([0, 0]);
    const vad = new SileroVad(runtime);
    await vad.probability(frameOf(0.25));
    await vad.probability(frameOf(0.5));
    const first = calls[0]?.input as Feed;
    const second = calls[1]?.input as Feed;
    expect(first.dims).toEqual([1, 576]);
    expect(Array.from(first.data.slice(0, 64))).toEqual(new Array(64).fill(0)); // no history yet
    expect(second.data[0]).toBeCloseTo(0.25); // tail of the first frame
    expect(second.data[64]).toBeCloseTo(0.5);
    expect((calls[1]?.state as Feed).data[0]).toBe(1); // state returned by the first run
    expect((calls[0]?.sr as { data: BigInt64Array }).data[0]).toBe(16000n);
  });

  it('rejects frames of the wrong size and tolerates a missing output', async () => {
    const vad = new SileroVad({
      tensor: (type, data, dims) => ({ type, data, dims }),
      run: () => Promise.resolve({ stateN: { data: [] } }),
    });
    await expect(vad.probability(new Float32Array(100))).rejects.toThrow(RangeError);
    expect(await vad.probability(frameOf(0))).toBe(0);
  });
});
