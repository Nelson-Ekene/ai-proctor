import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { page } from './page';

// Demo exam website, playing the integrator: its server holds the API key (never sent to the
// browser), starts a proctoring session through the real API for each candidate and hands the
// short-lived session token to the page, which starts the extension through the SDK.
//
//   DEMO_API_KEY=pak_... pnpm --filter @proctor/demo-host start   (or `pnpm demo`)

const here = dirname(fileURLToPath(import.meta.url));
const SDK_BUNDLE = join(here, '..', '..', '..', 'packages', 'sdk', 'build', 'proctor-sdk.js');

const PORT = Number(process.env.DEMO_PORT ?? 4500);
/** Where this server reaches the API. */
const API_URL = (process.env.PROCTOR_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
/** The API base the extension uses (must be in the extension's PROCTOR_API_ORIGINS). */
const PUBLIC_API_URL = (process.env.PROCTOR_PUBLIC_API_URL ?? API_URL).replace(/\/+$/, '');
const API_KEY = process.env.DEMO_API_KEY ?? '';
/** Development extension ID (pinned by the dev key in apps/extension/src/manifest.ts). */
const EXTENSION_ID = process.env.EXTENSION_ID ?? 'akponalihmmaihgcnonegjelddajfdka';
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'http://localhost:5173';

if (!API_KEY.startsWith('pak_')) {
  console.error('Set DEMO_API_KEY to an integrator API key (printed by the API seed).');
  process.exit(1);
}

function send(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
}

/** Starts a session for a candidate via the integrator API (POST /v1/sessions). */
async function startSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJson(req)) as { candidateRef?: unknown };
  const candidateRef =
    typeof body.candidateRef === 'string' && body.candidateRef.trim() !== ''
      ? body.candidateRef.trim().slice(0, 200)
      : `candidate-${String(Date.now())}`;
  const api = await fetch(`${API_URL}/v1/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ candidateRef }),
  });
  if (!api.ok) {
    send(
      res,
      502,
      JSON.stringify({ error: `API answered ${String(api.status)}` }),
      'application/json',
    );
    return;
  }
  const { sessionToken } = (await api.json()) as { sessionToken: string };
  send(
    res,
    200,
    JSON.stringify({
      sessionToken,
      apiBase: PUBLIC_API_URL,
      extensionId: EXTENSION_ID,
      candidateRef,
    }),
    'application/json',
  );
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', `http://localhost:${String(PORT)}`);
  void (async () => {
    try {
      if (req.method === 'GET' && pathname === '/') {
        send(res, 200, page({ dashboardUrl: DASHBOARD_URL }), 'text/html; charset=utf-8');
      } else if (req.method === 'GET' && pathname === '/proctor-sdk.js') {
        send(res, 200, await readFile(SDK_BUNDLE, 'utf8'), 'text/javascript');
      } else if (req.method === 'POST' && pathname === '/api/start') {
        await startSession(req, res);
      } else if (pathname === '/favicon.ico') {
        send(res, 204, '', 'text/plain');
      } else {
        send(res, 404, 'not found', 'text/plain');
      }
    } catch (error) {
      console.error(error);
      send(res, 500, JSON.stringify({ error: 'demo host error' }), 'application/json');
    }
  })();
});

server.listen(PORT, () => {
  console.log(`demo exam site: http://localhost:${String(PORT)} (API ${API_URL})`);
});
