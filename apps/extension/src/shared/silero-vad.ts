// Silero VAD v5 (bundled ONNX model, run on-device with onnxruntime-web). Outputs the
// probability that a 32 ms frame contains speech. Nothing is recorded or kept here.

/** Model contract (verified against silero_vad.onnx v5.1.2). */
export const VAD_SAMPLE_RATE = 16_000;
export const VAD_FRAME = 512;
/** v5 expects the last 64 samples of the previous frame prepended to each frame. */
const CONTEXT = 64;
const STATE_SHAPE = [2, 1, 128] as const;

interface TensorLike {
  data: ArrayLike<number | bigint | string>;
}

/** The slice of onnxruntime-web this wrapper needs (injectable for tests). */
export interface VadRuntime {
  run(feeds: Record<string, unknown>): Promise<Record<string, TensorLike>>;
  tensor(
    type: 'float32' | 'int64',
    data: Float32Array | BigInt64Array,
    dims: readonly number[],
  ): unknown;
}

export class SileroVad {
  private state: unknown;
  private context = new Float32Array(CONTEXT);
  private readonly sr: unknown;

  constructor(private readonly runtime: VadRuntime) {
    this.state = runtime.tensor('float32', new Float32Array(2 * 128), STATE_SHAPE);
    this.sr = runtime.tensor('int64', BigInt64Array.from([BigInt(VAD_SAMPLE_RATE)]), []);
  }

  /** Speech probability (0-1) for one 512-sample frame at 16 kHz. Frames must be in order. */
  async probability(frame: Float32Array): Promise<number> {
    if (frame.length !== VAD_FRAME) throw new RangeError(`expected ${String(VAD_FRAME)} samples`);
    const input = new Float32Array(CONTEXT + VAD_FRAME);
    input.set(this.context, 0);
    input.set(frame, CONTEXT);
    const out = await this.runtime.run({
      input: this.runtime.tensor('float32', input, [1, CONTEXT + VAD_FRAME]),
      state: this.state,
      sr: this.sr,
    });
    this.state = out.stateN;
    this.context = frame.slice(VAD_FRAME - CONTEXT);
    return Number(out.output?.data[0] ?? 0);
  }
}

/** Loads the bundled model with the bundled wasm runtime (no network access). */
export async function loadSileroVad(): Promise<SileroVad> {
  const ort = await import('onnxruntime-web/wasm');
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/onnx/');
  // Threads need cross-origin isolation, which extension documents do not have.
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(
    chrome.runtime.getURL('vendor/models/silero_vad.onnx'),
    { executionProviders: ['wasm'] },
  );
  return new SileroVad({
    run: (feeds) => session.run(feeds as Record<string, InstanceType<typeof ort.Tensor>>),
    tensor: (type, data, dims) => new ort.Tensor(type, data, dims),
  });
}
