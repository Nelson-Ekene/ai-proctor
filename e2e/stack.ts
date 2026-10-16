import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

// The real backend for e2e suites that need it (dashboard, full stack): Postgres + MinIO
// containers, the seeded API, and helpers to run the repo's Node servers. Docker required.

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, '..');
export const API_DIR = join(REPO, 'apps', 'api');
export const DASHBOARD_DIR = join(REPO, 'apps', 'dashboard');
export const DEMO_HOST_DIR = join(REPO, 'apps', 'demo-host');

type Child = ChildProcessByStdio<null, Readable, Readable>;

export interface Stack {
  /** Environment for the API, seed and anything else talking to the database/storage. */
  env: NodeJS.ProcessEnv;
  /** Integrator API key printed by the seed. */
  apiKey: string;
  start: (name: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Child;
  teardown: () => Promise<void>;
}

export async function waitForUrl(url: string, timeoutMs: number, child?: Child): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`${url}: process exited with ${String(child.exitCode)}`);
    }
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} did not come up within ${String(timeoutMs)} ms`);
}

/** Starts the containers and seeds the database (users, API key, optional demo sessions). */
export async function startStack(opts: {
  apiPort: number;
  seedPassword: string;
  demo: boolean;
}): Promise<Stack> {
  const containers: StartedTestContainer[] = [];
  const children: Child[] = [];
  const teardown = async () => {
    for (const child of children) child.kill();
    await Promise.all(containers.map((c) => c.stop()));
  };
  const start = (name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...stackEnv, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (process.env.E2E_STACK_VERBOSE) process.stdout.write(`[${name}] ${chunk.toString()}`);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(`[${name}] ${chunk.toString()}`);
    });
    children.push(child);
    return child;
  };
  let stackEnv: NodeJS.ProcessEnv = { ...process.env };
  try {
    const [postgres, minio] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine').start(),
      new GenericContainer('cgr.dev/chainguard/minio:latest')
        .withCommand(['server', '/data'])
        .withEnvironment({
          MINIO_ROOT_USER: 'proctor-e2e',
          MINIO_ROOT_PASSWORD: 'proctor-e2e-secret',
          MINIO_KMS_SECRET_KEY: `e2e-key:${randomBytes(32).toString('base64')}`,
        })
        .withExposedPorts(9000)
        .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000))
        .start(),
    ]);
    containers.push(postgres, minio);
    stackEnv = {
      ...process.env,
      DATABASE_URL: postgres.getConnectionUri(),
      S3_ENDPOINT: `http://${minio.getHost()}:${String(minio.getMappedPort(9000))}`,
      S3_BUCKET: 'evidence',
      S3_ACCESS_KEY: 'proctor-e2e',
      S3_SECRET_KEY: 'proctor-e2e-secret',
      PORT: String(opts.apiPort),
      HOST: '127.0.0.1',
      SEED_PASSWORD: opts.seedPassword,
    };
    const seed = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/seed.ts', ...(opts.demo ? ['--demo'] : [])],
      { cwd: API_DIR, env: stackEnv, encoding: 'utf8' },
    );
    if (seed.status !== 0) throw new Error(`seed failed:\n${seed.stdout}\n${seed.stderr}`);
    const apiKey = /integrator API key \(shown once\): (pak_\S+)/.exec(seed.stdout)?.[1];
    if (!apiKey) throw new Error(`seed printed no API key:\n${seed.stdout}`);

    const api = start('api', ['--import', 'tsx', 'src/server.ts'], API_DIR);
    await waitForUrl(`http://localhost:${String(opts.apiPort)}/healthz`, 60_000, api);
    return { env: stackEnv, apiKey, start, teardown };
  } catch (error) {
    await teardown();
    throw error;
  }
}
