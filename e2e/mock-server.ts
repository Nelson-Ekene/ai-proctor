// Mock exam host page (:4400) and mock proctoring API (:4401) for e2e tests and manual testing.
// Ports can be overridden with MOCK_HOST_PORT / MOCK_API_PORT (see settings.ts).
// Run: pnpm --filter @proctor/e2e mock   (after building the SDK and the extension)
import { ConsentRecordSchema, DEFAULT_POLICY, EndSessionSchema, type Policy } from '@proctor/core';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_PORT, HOST_PORT } from './settings.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SDK_BUNDLE = join(here, '..', 'packages', 'sdk', 'build', 'proctor-sdk.js');

export interface MockState {
  sessionFetches: string[];
  consents: { sessionId: string; decision: string; noticeVersion: string; ts: number }[];
  ends: { sessionId: string; ts: number }[];
  /** Every API request (method, path, body bytes), to prove what was and wasn't uploaded. */
  requests: { method: string; path: string; bytes: number }[];
}

const state: MockState = { sessionFetches: [], consents: [], ends: [], requests: [] };
/** Number of upcoming consent POSTs to fail with 503 (simulates an unreachable backend). */
let failConsents = 0;

function send(
  res: ServerResponse,
  status: number,
  body?: unknown,
  type = 'application/json',
): void {
  res.writeHead(status, { 'content-type': type });
  res.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') as unknown;
}

/** Token "tok-<x>" maps to session "sess-<x>"; anything else is unauthorised. */
function sessionFor(req: IncomingMessage): string | undefined {
  const match = /^Bearer tok-([\w-]+)$/.exec(req.headers.authorization ?? '');
  return match ? `sess-${match[1] ?? ''}` : undefined;
}

/**
 * Test policies so tests (and humans) need not wait for production timings:
 * - "tok-fastidle": 3 s inactivity threshold
 * - "tok-fastvideo": one webcam sample per second, 2 s sustained gaze, quick bursts
 * - "tok-fastaudio": 2 s audio buffer, 5 s clip cap, 0.8 s silence ends a clip
 */
function policyFor(sessionId: string): Policy {
  if (sessionId === 'sess-fastidle') {
    return { ...DEFAULT_POLICY, inactivity: { seconds: 3, pingSeconds: 0.5 } };
  }
  if (sessionId === 'sess-fastaudio') {
    // Short buffer and a 5 s clip cap so the cap is exercised within seconds.
    return {
      ...DEFAULT_POLICY,
      audio: { ...DEFAULT_POLICY.audio, bufferSeconds: 2, maxClipSeconds: 5, silenceEndMs: 800 },
    };
  }
  if (sessionId === 'sess-fastvideo') {
    return {
      ...DEFAULT_POLICY,
      sampling: { framesPerWindow: 5, windowSeconds: 5 },
      gazeAway: { ...DEFAULT_POLICY.gazeAway, sustainedSeconds: 2 },
      video: { ...DEFAULT_POLICY.video, burstIntervalMs: 300 },
    };
  }
  return DEFAULT_POLICY;
}

const HOST_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mock exam</title></head>
<body>
  <h1>Mock exam page</h1>
  <p>Simulates an integrator's exam site using the proctoring SDK.</p>
  <button id="start">Start proctoring</button>
  <button id="end">End session</button>
  <ul id="events"></ul>

  <section id="rule-tests">
    <h2>Browser rule test page</h2>
    <p>After the session is ready, trigger each browser violation type:</p>
    <ol>
      <li>Fullscreen exit: <button id="fs-enter">Enter fullscreen</button>
        then <button id="fs-exit">Exit fullscreen</button> (or press Esc).</li>
      <li>Tab switch / blur: switch to another tab or window, then come back.</li>
      <li>Copy / paste: select text below and press Ctrl+C, then Ctrl+V into the box.</li>
      <li>Refresh attempt: press F5 or Ctrl+R (the session continues after the reload).</li>
      <li>Inactivity: stop using mouse and keyboard for the policy's inactivity time
        (60 s by default; 3 s with <code>?token=tok-fastidle</code>).</li>
    </ol>
    <p id="question">Question 7: SECRET-ANSWER-42 is the text a reviewer must never see in logs.</p>
    <textarea id="notes" rows="3" cols="60">SECRET-ANSWER-42</textarea>
  </section>

  <script type="module">
    document.getElementById('fs-enter').addEventListener('click', () => {
      void document.documentElement.requestFullscreen();
    });
    document.getElementById('fs-exit').addEventListener('click', () => {
      if (document.fullscreenElement) void document.exitFullscreen();
    });
  </script>
  <script type="module">
    import { Proctor } from '/proctor-sdk.js';
    const params = new URLSearchParams(location.search);
    const extensionId = params.get('ext') ?? 'akponalihmmaihgcnonegjelddajfdka';
    const sessionToken = params.get('token') ?? 'tok-demo';
    const apiBase = params.get('api') ?? 'http://localhost:${String(API_PORT)}';
    const log = (text) => {
      const li = document.createElement('li');
      li.textContent = text;
      document.getElementById('events').append(li);
    };
    let session;
    document.getElementById('start').addEventListener('click', async () => {
      try {
        session = await Proctor.start({ sessionToken, apiBase, extensionId });
        for (const name of ['ready', 'consent_declined', 'ended']) session.on(name, () => log(name));
        log('started:' + session.sessionId);
      } catch (e) {
        log('error:' + (e.code ?? e.message));
      }
    });
    document.getElementById('end').addEventListener('click', async () => {
      try { await session.end(); } catch (e) { log('error:' + (e.code ?? e.message)); }
    });
  </script>
</body></html>`;

interface Reply {
  status: number;
  body?: unknown;
  type?: string;
}

async function handleHost(path: string): Promise<Reply> {
  if (path === '/') return { status: 200, body: HOST_PAGE, type: 'text/html; charset=utf-8' };
  if (path === '/favicon.ico') return { status: 204 }; // keeps 404 noise out of diagnostics
  if (path === '/proctor-sdk.js') {
    try {
      return { status: 200, body: await readFile(SDK_BUNDLE, 'utf8'), type: 'text/javascript' };
    } catch {
      return {
        status: 500,
        body: 'SDK not built: run pnpm --filter @proctor/sdk build',
        type: 'text/plain',
      };
    }
  }
  return { status: 404, body: 'not found', type: 'text/plain' };
}

async function handleApi(req: IncomingMessage, url: URL): Promise<Reply> {
  const path = url.pathname;
  // Test-only control endpoints.
  if (path === '/__test/state') return { status: 200, body: state };
  if (path === '/__test/reset' && req.method === 'POST') {
    state.sessionFetches.length = 0;
    state.consents.length = 0;
    state.ends.length = 0;
    state.requests.length = 0;
    failConsents = 0;
    return { status: 204 };
  }
  if (path === '/__test/fail-consents' && req.method === 'POST') {
    failConsents = Number(url.searchParams.get('count') ?? '1');
    return { status: 204 };
  }

  state.requests.push({
    method: req.method ?? 'GET',
    path,
    bytes: Number(req.headers['content-length'] ?? 0),
  });
  const sessionId = sessionFor(req);
  if (!sessionId) return { status: 401, body: { error: 'unauthorised' } };

  if (path === '/v1/sessions/current' && req.method === 'GET') {
    state.sessionFetches.push(sessionId);
    return { status: 200, body: { sessionId, policySnapshot: policyFor(sessionId) } };
  }
  const match = /^\/v1\/sessions\/([^/]+)\/(consents|end)$/.exec(path);
  if (match && req.method === 'POST' && decodeURIComponent(match[1] ?? '') === sessionId) {
    const body = await readJson(req);
    if (match[2] === 'consents') {
      if (failConsents > 0) {
        failConsents -= 1;
        return { status: 503, body: { error: 'unavailable' } };
      }
      const parsed = ConsentRecordSchema.safeParse(body);
      if (!parsed.success) return { status: 400, body: { error: 'invalid consent record' } };
      state.consents.push({ sessionId, ...parsed.data });
      return { status: 201, body: { ok: true } };
    }
    const parsed = EndSessionSchema.safeParse(body);
    if (!parsed.success) return { status: 400, body: { error: 'invalid end' } };
    state.ends.push({ sessionId, ...parsed.data });
    return { status: 204 };
  }
  return { status: 404, body: { error: 'not found' } };
}

const host = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', `http://localhost:${String(HOST_PORT)}`);
  void handleHost(pathname).then((r) => {
    send(res, r.status, r.body, r.type);
  });
});

const api = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${String(API_PORT)}`);
  void handleApi(req, url).then((r) => {
    send(res, r.status, r.body, r.type);
  });
});

host.listen(HOST_PORT, () => {
  console.log(`mock exam host: http://localhost:${String(HOST_PORT)}`);
});
api.listen(API_PORT, () => {
  console.log(`mock API:       http://localhost:${String(API_PORT)}`);
});
