import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { prepareAudioFixtures } from './audio-fixtures.ts';
import {
  FULLSTACK_API_PORT,
  FULLSTACK_API_URL,
  FULLSTACK_HOST_PORT,
  FULLSTACK_HOST_URL,
  FULLSTACK_PROXY_PORT,
  FULLSTACK_PROXY_URL,
  SEED_PASSWORD,
} from './settings.ts';
import { DEMO_HOST_DIR, startStack, waitForUrl } from './stack.ts';
import { prepareVideoFixtures } from './video-fixtures.ts';

// Full stack for the end-to-end privacy and performance suites:
//   extension (built, fake camera/mic) → recording proxy :4621 → real API :4622 → Postgres/MinIO
//   demo exam site :4620 (starts sessions with the integrator API key, server-side)
// The proxy records every request the extension makes (method, path, headers, body) so tests
// can assert exactly what leaves the device. GET /__proxy/log returns it; POST /__proxy/reset.

export interface ProxyEntry {
  method: string;
  path: string;
  contentType: string;
  status: number;
  /** Body, base64. */
  body: string;
  bytes: number;
  ts: number;
}

function startProxy(): Promise<() => Promise<void>> {
  const log: ProxyEntry[] = [];
  const target = new URL(FULLSTACK_API_URL);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? '/';
    if (path === '/__proxy/log') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(log));
      return;
    }
    if (path === '/__proxy/reset' && req.method === 'POST') {
      log.length = 0;
      res.writeHead(204).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const upstream = request(
        {
          hostname: target.hostname,
          port: target.port,
          method: req.method,
          path,
          headers: { ...req.headers, host: target.host },
        },
        (upstreamRes) => {
          // Only the extension's API calls are recorded (not CORS preflights).
          if (req.method !== 'OPTIONS') {
            log.push({
              method: req.method ?? 'GET',
              path,
              contentType: req.headers['content-type'] ?? '',
              status: upstreamRes.statusCode ?? 0,
              body: body.toString('base64'),
              bytes: body.length,
              ts: Date.now(),
            });
          }
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      upstream.on('error', () => {
        res.writeHead(502).end();
      });
      upstream.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(FULLSTACK_PROXY_PORT, () => {
      resolve(
        () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => {
              done();
            });
          }),
      );
    });
  });
}

export default async function setup(): Promise<() => Promise<void>> {
  await prepareVideoFixtures();
  await prepareAudioFixtures();
  const stack = await startStack({
    apiPort: FULLSTACK_API_PORT,
    seedPassword: SEED_PASSWORD,
    demo: false,
  });
  let stopProxy: (() => Promise<void>) | undefined;
  try {
    stopProxy = await startProxy();
    await waitForUrl(`${FULLSTACK_PROXY_URL}/healthz`, 10_000);
    const host = stack.start('exam-site', ['--import', 'tsx', 'src/server.ts'], DEMO_HOST_DIR, {
      DEMO_API_KEY: stack.apiKey,
      DEMO_PORT: String(FULLSTACK_HOST_PORT),
      PROCTOR_API_URL: FULLSTACK_API_URL,
      PROCTOR_PUBLIC_API_URL: FULLSTACK_PROXY_URL,
    });
    await waitForUrl(FULLSTACK_HOST_URL, 30_000, host);
  } catch (error) {
    await stopProxy?.();
    await stack.teardown();
    throw error;
  }
  const stop = stopProxy;
  return async () => {
    await stop();
    await stack.teardown();
  };
}
