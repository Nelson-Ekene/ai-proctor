// Mock exam host page (:4400) and mock proctoring API (:4401) for e2e tests and manual testing.
// Ports can be overridden with MOCK_HOST_PORT / MOCK_API_PORT (see settings.ts).
// Run: pnpm --filter @proctor/e2e mock   (after building the SDK and the extension)
import {
  AnomalySchema,
  ConsentRecordSchema,
  DEFAULT_POLICY,
  EndSessionSchema,
  type Policy,
} from '@proctor/core';
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
  /** Anomaly records received (first delivery of each idempotency key only). */
  anomalies: { id: string; sessionId: string; type: string; ts: number; evidenceIds: string[] }[];
  /** Evidence bodies received (first delivery only). */
  evidence: { id: string; sessionId: string; contentType: string; bytes: number }[];
  /** Requests carrying an already-processed idempotency key (retries after a lost reply). */
  duplicates: number;
  /** Requests cut off because the simulated network was down. */
  refused: number;
}

const state: MockState = {
  sessionFetches: [],
  consents: [],
  ends: [],
  requests: [],
  anomalies: [],
  evidence: [],
  duplicates: 0,
  refused: 0,
};
/** Number of upcoming consent POSTs to fail with 503 (simulates an unreachable backend). */
let failConsents = 0;
/** Idempotency keys already processed: a repeat is acknowledged but never stored twice. */
const seenKeys = new Set<string>();
/**
 * Simulated network for /v1 requests:
 * - up: normal
 * - down: the connection is cut before the request is processed (network loss)
 * - drop-after: the request is processed, then the connection is cut (lost reply), `dropCount`
 *   times
 */
const network = { mode: 'up' as 'up' | 'down' | 'drop-after', dropCount: 0 };
const EVIDENCE_TYPES = new Set(['image/jpeg', 'audio/wav', 'application/json']);

function send(
  res: ServerResponse,
  status: number,
  body?: unknown,
  type = 'application/json',
): void {
  res.writeHead(status, { 'content-type': type });
  res.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  return JSON.parse((await readBody(req)).toString('utf8') || 'null') as unknown;
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
 * - "tok-fastupload": fast video + audio, short capture windows and quick upload retries
 */
function policyFor(sessionId: string): Policy {
  if (sessionId === 'sess-fastupload') {
    return {
      ...DEFAULT_POLICY,
      sampling: { framesPerWindow: 5, windowSeconds: 5 },
      video: { ...DEFAULT_POLICY.video, burstIntervalMs: 300 },
      audio: { ...DEFAULT_POLICY.audio, bufferSeconds: 2, maxClipSeconds: 5, silenceEndMs: 800 },
      capture: {
        ...DEFAULT_POLICY.capture,
        eventsBeforeSeconds: 5,
        eventsAfterSeconds: 3,
        logRetentionSeconds: 10,
      },
      upload: { ...DEFAULT_POLICY.upload, retryBaseMs: 500, retryMaxMs: 2000 },
    };
  }
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
  /** Cut the connection instead of replying (simulated network failure). */
  destroy?: boolean;
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
    state.anomalies.length = 0;
    state.evidence.length = 0;
    state.duplicates = 0;
    state.refused = 0;
    seenKeys.clear();
    failConsents = 0;
    network.mode = 'up';
    network.dropCount = 0;
    return { status: 204 };
  }
  if (path === '/__test/fail-consents' && req.method === 'POST') {
    failConsents = Number(url.searchParams.get('count') ?? '1');
    return { status: 204 };
  }
  if (path === '/__test/network' && req.method === 'POST') {
    const mode = url.searchParams.get('mode');
    if (mode !== 'up' && mode !== 'down' && mode !== 'drop-after') return { status: 400 };
    network.mode = mode;
    network.dropCount = Number(url.searchParams.get('count') ?? '0');
    return { status: 204 };
  }

  state.requests.push({
    method: req.method ?? 'GET',
    path,
    bytes: Number(req.headers['content-length'] ?? 0),
  });
  if (network.mode === 'down') {
    state.refused += 1;
    return { status: 0, destroy: true };
  }
  const sessionId = sessionFor(req);
  if (!sessionId) return { status: 401, body: { error: 'unauthorised' } };

  const key = req.headers['idempotency-key'];
  if (typeof key === 'string' && seenKeys.has(key)) {
    await readBody(req);
    state.duplicates += 1;
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  const reply = await process(req, path, sessionId);
  if (reply.status >= 200 && reply.status < 300) {
    if (typeof key === 'string') seenKeys.add(key);
    if (network.mode === 'drop-after' && network.dropCount > 0) {
      network.dropCount -= 1;
      if (network.dropCount === 0) network.mode = 'up';
      return { status: 0, destroy: true }; // processed, but the reply never arrives
    }
  }
  return reply;
}

async function process(req: IncomingMessage, path: string, sessionId: string): Promise<Reply> {
  if (path === '/v1/sessions/current' && req.method === 'GET') {
    state.sessionFetches.push(sessionId);
    return { status: 200, body: { sessionId, policySnapshot: policyFor(sessionId) } };
  }
  const session = /^\/v1\/sessions\/([^/]+)\/(consents|end|anomalies)$/.exec(path);
  if (session && req.method === 'POST' && decodeURIComponent(session[1] ?? '') === sessionId) {
    const body = await readJson(req);
    if (session[2] === 'consents') {
      if (failConsents > 0) {
        failConsents -= 1;
        return { status: 503, body: { error: 'unavailable' } };
      }
      const parsed = ConsentRecordSchema.safeParse(body);
      if (!parsed.success) return { status: 400, body: { error: 'invalid consent record' } };
      state.consents.push({ sessionId, ...parsed.data });
      return { status: 201, body: { ok: true } };
    }
    if (session[2] === 'anomalies') {
      const parsed = AnomalySchema.safeParse(body);
      if (!parsed.success) return { status: 400, body: { error: 'invalid anomaly' } };
      const a = parsed.data;
      state.anomalies.push({
        id: a.id,
        sessionId,
        type: a.type,
        ts: a.ts,
        evidenceIds: a.evidence.map((e) => e.id),
      });
      return { status: 201, body: { ok: true } };
    }
    const parsed = EndSessionSchema.safeParse(body);
    if (!parsed.success) return { status: 400, body: { error: 'invalid end' } };
    state.ends.push({ sessionId, ...parsed.data });
    return { status: 204 };
  }
  const evidence = /^\/v1\/sessions\/([^/]+)\/evidence\/([^/]+)$/.exec(path);
  if (evidence && req.method === 'PUT' && decodeURIComponent(evidence[1] ?? '') === sessionId) {
    const contentType = req.headers['content-type'] ?? '';
    const bytes = await readBody(req);
    if (!EVIDENCE_TYPES.has(contentType) || bytes.length === 0) {
      return { status: 400, body: { error: 'invalid evidence' } };
    }
    state.evidence.push({
      id: decodeURIComponent(evidence[2] ?? ''),
      sessionId,
      contentType,
      bytes: bytes.length,
    });
    return { status: 201, body: { ok: true } };
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
    if (r.destroy) {
      req.socket.destroy(); // simulated network failure: no response at all
      return;
    }
    send(res, r.status, r.body, r.type);
  });
});

host.listen(HOST_PORT, () => {
  console.log(`mock exam host: http://localhost:${String(HOST_PORT)}`);
});
api.listen(API_PORT, () => {
  console.log(`mock API:       http://localhost:${String(API_PORT)}`);
});
