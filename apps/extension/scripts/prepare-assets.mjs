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
];

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

// The package does not export package.json; its entry bundle sits at the package root.
const wasmDir = join(dirname(require.resolve('@mediapipe/tasks-vision')), 'wasm');
for (const f of WASM_FILES) await copyFile(join(wasmDir, f), join(vendor, 'mediapipe', f));

for (const m of MODELS) console.log(`model ${m.file}: ${await ensureModel(m)}`);
console.log('assets ready in public/vendor');
