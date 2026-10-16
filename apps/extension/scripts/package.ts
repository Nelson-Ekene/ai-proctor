// Builds the Chrome Web Store package: `pnpm --filter @proctor/extension package`.
// Requires real https origins, e.g.
//   PROCTOR_EXAM_ORIGINS=https://exam.example.com PROCTOR_API_ORIGINS=https://api.example.com
// Builds in production mode, runs the release check (src/release.ts) and writes
// release/hawkeye-<version>.zip. Run with Node 24 (native TypeScript type stripping).
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import type { ProctorManifest } from '../src/manifest.ts';
import { releaseProblems } from '../src/release.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// A separate output folder, so packaging never replaces the dev/e2e build in build/.
const build = join(root, 'build-release');

if (!process.env.PROCTOR_EXAM_ORIGINS || !process.env.PROCTOR_API_ORIGINS) {
  console.error('Set PROCTOR_EXAM_ORIGINS and PROCTOR_API_ORIGINS to the real https origins.');
  process.exit(1);
}
if (process.env.PROCTOR_DIAGNOSTICS) {
  console.error('Unset PROCTOR_DIAGNOSTICS: the diagnostics page is never shipped.');
  process.exit(1);
}

execSync('pnpm run build', {
  cwd: root,
  env: { ...process.env, PROCTOR_BUILD_DIR: 'build-release' },
  stdio: 'inherit',
});

function list(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? list(path) : [relative(build, path).split(sep).join('/')];
  });
}

const files = list(build).sort();
const manifest = JSON.parse(readFileSync(join(build, 'manifest.json'), 'utf8')) as ProctorManifest;
const problems = releaseProblems(manifest, files);
if (problems.length > 0) {
  console.error(`Not packaged:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

/** Minimal ZIP writer (deflate), so packaging needs no extra dependency. */
function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

const archive = zip(files.map((name) => ({ name, data: readFileSync(join(build, name)) })));
const out = join(root, 'release', `hawkeye-${manifest.version}.zip`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, archive);
console.log(
  `Packaged ${String(files.length)} files (${(archive.length / 1e6).toFixed(1)} MB): ${out}`,
);
