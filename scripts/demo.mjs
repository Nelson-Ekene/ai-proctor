// `pnpm demo`: runs the whole application locally so you can try it end to end.
//
//   1. Postgres + MinIO (docker compose, infra/docker-compose.yml)
//   2. API on http://localhost:4000 (migrations + seed: admin/reviewer logins, API key, demo data)
//   3. Reviewer dashboard on http://localhost:5173
//   4. Demo exam website on http://localhost:4500 (starts sessions with the integrator API key)
//   5. Builds the SDK and the development extension (apps/extension/build) if needed
//
// Then load apps/extension/build as an unpacked extension in Chrome and open the exam site.
// Ctrl+C stops the servers (the docker services keep running; `docker compose ... down` stops them).
import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const PASSWORD = process.env.SEED_PASSWORD ?? 'change-me-please';
const PORTS = { api: 4000, dashboard: 5173, host: 4500 };
const EXTENSION_BUILD = join(root, 'apps', 'extension', 'build');

const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://proctor:proctor@localhost:5432/proctor',
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  S3_BUCKET: process.env.S3_BUCKET ?? 'evidence',
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? 'proctor-minio',
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? 'proctor-minio-secret',
  PORT: String(PORTS.api),
  SEED_PASSWORD: PASSWORD,
};

function step(text) {
  console.log(`\n▶ ${text}`);
}

function run(command, cwd = root) {
  execSync(command, { cwd, stdio: 'inherit', env });
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function waitFor(url, child, name) {
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`${name} exited (code ${child.exitCode})`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${name} did not start: ${url}`);
}

const children = [];
function start(name, command, cwd, extraEnv = {}) {
  const child = spawn(process.execPath, command, {
    cwd,
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => `[${name}] ${l}`)
      .join('\n');
  child.stdout.on('data', (c) => {
    if (args.has('--verbose')) console.log(prefix(c));
  });
  child.stderr.on('data', (c) => console.error(prefix(c)));
  children.push(child);
  return child;
}

function stopAll() {
  for (const child of children) child.kill();
}
process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});

function extensionBuildIsCurrent() {
  try {
    const manifest = JSON.parse(readFileSync(join(EXTENSION_BUILD, 'manifest.json'), 'utf8'));
    return (
      manifest.key !== undefined &&
      manifest.externally_connectable.matches.includes(`http://localhost:${PORTS.host}/*`) &&
      manifest.host_permissions.includes(`http://localhost:${PORTS.api}/*`)
    );
  } catch {
    return false;
  }
}

try {
  step('Checking Docker and ports');
  if (spawnSync('docker', ['info'], { stdio: 'ignore', shell: true }).status !== 0) {
    throw new Error('Docker is not running. Start Docker Desktop and run `pnpm demo` again.');
  }
  for (const [name, port] of Object.entries(PORTS)) {
    if (!(await portFree(port)))
      throw new Error(`Port ${port} (${name}) is in use. Stop whatever runs there first.`);
  }

  step('Starting Postgres and MinIO (docker compose)');
  run('docker compose -f infra/docker-compose.yml up -d --wait postgres minio');
  run('docker compose -f infra/docker-compose.yml up minio-init');

  step('Building the SDK and the development extension');
  run('pnpm --filter @proctor/sdk build');
  if (args.has('--rebuild-extension') || !extensionBuildIsCurrent()) {
    run('pnpm --filter @proctor/extension build:dev');
  } else {
    console.log('extension build is current (use --rebuild-extension to force)');
  }

  step('Migrating and seeding the database');
  const seed = spawnSync(process.execPath, ['--import', 'tsx', 'src/seed.ts', '--demo-if-empty'], {
    cwd: join(root, 'apps', 'api'),
    env,
    encoding: 'utf8',
  });
  if (seed.status !== 0) throw new Error(`seed failed:\n${seed.stdout}\n${seed.stderr}`);
  console.log(seed.stdout.trim());
  const apiKey = /integrator API key \(shown once\): (pak_\S+)/.exec(seed.stdout)?.[1];
  if (!apiKey) throw new Error('seed did not print an API key');

  step('Starting the API, dashboard and demo exam site');
  const api = start('api', ['--import', 'tsx', 'src/server.ts'], join(root, 'apps', 'api'));
  await waitFor(`http://localhost:${PORTS.api}/healthz`, api, 'API');
  const dashboard = start(
    'dashboard',
    [
      join(root, 'apps', 'dashboard', 'node_modules', 'vite', 'bin', 'vite.js'),
      '--port',
      String(PORTS.dashboard),
      '--strictPort',
    ],
    join(root, 'apps', 'dashboard'),
    { PROCTOR_API_URL: `http://localhost:${PORTS.api}` },
  );
  await waitFor(`http://localhost:${PORTS.dashboard}`, dashboard, 'dashboard');
  const host = start(
    'exam-site',
    ['--import', 'tsx', 'src/server.ts'],
    join(root, 'apps', 'demo-host'),
    {
      DEMO_API_KEY: apiKey,
      DEMO_PORT: String(PORTS.host),
      PROCTOR_API_URL: `http://localhost:${PORTS.api}`,
      DASHBOARD_URL: `http://localhost:${PORTS.dashboard}`,
    },
  );
  await waitFor(`http://localhost:${PORTS.host}`, host, 'demo exam site');

  console.log(`
────────────────────────────────────────────────────────────────────────
 The Hawkeye demo is running.

 1. Install the extension (once):
      Chrome → chrome://extensions → turn on "Developer mode" →
      "Load unpacked" → choose  ${EXTENSION_BUILD}
      (after a rebuild, press the reload icon on the extension card)

 2. Take an exam:     http://localhost:${PORTS.host}
      Start exam → accept the consent notice → run the setup check →
      try the checks on the page → Finish exam

 3. Review it:        http://localhost:${PORTS.dashboard}
      reviewer@proctor.test / ${PASSWORD}   (reviewer)
      admin@proctor.test    / ${PASSWORD}   (admin: policy, metrics, audit log)

 API: http://localhost:${PORTS.api}   MinIO console: http://localhost:9001
 Press Ctrl+C to stop.
────────────────────────────────────────────────────────────────────────`);
  if (!existsSync(join(EXTENSION_BUILD, 'manifest.json'))) console.warn('extension build missing!');
} catch (error) {
  console.error(`\n✖ ${error instanceof Error ? error.message : String(error)}`);
  stopAll();
  process.exit(1);
}
