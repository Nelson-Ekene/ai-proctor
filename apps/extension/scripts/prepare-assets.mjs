// Copies MediaPipe wasm runtime and downloads pinned models into public/vendor at BUILD time.
// The extension never fetches models at runtime (BUILD_PLAN Phase 4.3).
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'public', 'vendor');
const require = createRequire(import.meta.url);

const MODELS = [
  {
    file: 'blaze_face_short_range.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    sha256: 'b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f',
  },
  {
    // COCO object detector: "person", "cell phone", "book" among its 80 labels.
    file: 'efficientdet_lite0.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite',
    sha256: '4b59100025bea1235a84c1038879a6cccc9f6c49f5e41144e91e74d99e780993',
  },
  {
    // Face landmarks + facial transformation matrix (head pose for the gaze-away proxy).
    file: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
  },
  {
    // Silero VAD v5 (MIT): voice-activity probability per 32 ms frame at 16 kHz.
    file: 'silero_vad.onnx',
    url: 'https://raw.githubusercontent.com/snakers4/silero-vad/v5.1.2/src/silero_vad/data/silero_vad.onnx',
    sha256: '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f',
  },
];

// onnxruntime-web runtime for Silero (single-threaded SIMD build; no WebGPU/JSEP needed).
const ORT_FILES = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];

// SIMD and non-SIMD builds; FilesetResolver picks one at runtime.
const WASM_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function ensureModel({ file, url, sha256: expected }) {
  const target = join(vendor, 'models', file);
  try {
    if (sha256(await readFile(target)) === expected) return 'cached';
  } catch {
    // not downloaded yet
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256(buf);
  if (actual !== expected) throw new Error(`Checksum mismatch for ${file}: ${actual}`);
  await writeFile(target, buf);
  return 'downloaded';
}

await mkdir(join(vendor, 'models'), { recursive: true });
await mkdir(join(vendor, 'mediapipe'), { recursive: true });
await mkdir(join(vendor, 'onnx'), { recursive: true });

// The package does not export package.json; its entry bundle sits at the package root.
const wasmDir = join(dirname(require.resolve('@mediapipe/tasks-vision')), 'wasm');
for (const f of WASM_FILES) await copyFile(join(wasmDir, f), join(vendor, 'mediapipe', f));

// onnxruntime-web's main entry lives in dist/, next to its wasm runtime files.
const ortDir = dirname(require.resolve('onnxruntime-web'));
for (const f of ORT_FILES) await copyFile(join(ortDir, f), join(vendor, 'onnx', f));

for (const m of MODELS) console.log(`model ${m.file}: ${await ensureModel(m)}`);
console.log('assets ready in public/vendor');
