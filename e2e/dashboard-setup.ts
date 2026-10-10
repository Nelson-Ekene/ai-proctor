import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import {
  DASHBOARD_API_URL,
  DASHBOARD_API_PORT,
  DASHBOARD_PORT,
  DASHBOARD_URL,
  SEED_PASSWORD,
} from './settings.ts';

// Real stack for the dashboard e2e test: Postgres + MinIO containers, the API server, the demo
// seed (same ingestion code as real uploads) and the dashboard's Vite dev server. Docker needed.

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, '..', 'apps', 'api');
const dashboardDir = join(here, '..', 'apps', 'dashboard');

async function waitFor(url: string, timeoutMs: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`${url}: process exited with ${String(child.exitCode)}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} did not come up within ${String(timeoutMs)} ms`);
}

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv, name: string) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = (chunk: Buffer) => {
    if (process.env.DASHBOARD_E2E_VERBOSE) process.stdout.write(`[${name}] ${chunk.toString()}`);
  };
  child.stdout.on('data', log);
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(`[${name}] ${chunk.toString()}`);
  });
  return child;
}

export default async function setup(): Promise<() => Promise<void>> {
  const containers: StartedTestContainer[] = [];
  const children: ChildProcess[] = [];
  const teardown = async () => {
    for (const child of children) child.kill();
    await Promise.all(containers.map((c) => c.stop()));
  };
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

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: postgres.getConnectionUri(),
      S3_ENDPOINT: `http://${minio.getHost()}:${String(minio.getMappedPort(9000))}`,
      S3_BUCKET: 'evidence',
      S3_ACCESS_KEY: 'proctor-e2e',
      S3_SECRET_KEY: 'proctor-e2e-secret',
      PORT: String(DASHBOARD_API_PORT),
      HOST: '127.0.0.1',
      SEED_PASSWORD,
    };

    const seed = spawnSync(process.execPath, ['--import', 'tsx', 'src/seed.ts', '--demo'], {
      cwd: apiDir,
      env,
      encoding: 'utf8',
    });
    if (seed.status !== 0) throw new Error(`seed failed:\n${seed.stdout}\n${seed.stderr}`);

    const api = run(['--import', 'tsx', 'src/server.ts'], apiDir, env, 'api');
    children.push(api);
    await waitFor(`${DASHBOARD_API_URL}/healthz`, 60_000, api);

    const vite = run(
      [
        join(dashboardDir, 'node_modules', 'vite', 'bin', 'vite.js'),
        '--port',
        String(DASHBOARD_PORT),
        '--strictPort',
      ],
      dashboardDir,
      { ...process.env, PROCTOR_API_URL: DASHBOARD_API_URL },
      'dashboard',
    );
    children.push(vite);
    await waitFor(DASHBOARD_URL, 60_000, vite);
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
