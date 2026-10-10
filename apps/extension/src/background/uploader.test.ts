import { describe, expect, it, vi } from 'vitest';
import type { MediaStore, QueueItem } from '../shared/evidence-store';
import { Uploader, isSecureApi } from './uploader';

const RETRY = { retryBaseMs: 1000, retryMaxMs: 8000, maxQueueBytes: 10_000 };
let seq = 0;

type RequestOverrides = {
  [K in keyof QueueItem['request']]?: QueueItem['request'][K] | undefined;
};

function item(over: Partial<QueueItem> = {}, overrides: RequestOverrides = {}): QueueItem {
  seq += 1;
  // `body: undefined` in overrides means "no inline body" (media items); other undefined
  // values are ignored.
  const request: Partial<QueueItem['request']> = { body: '{}' };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) Reflect.deleteProperty(request, key);
    else Object.assign(request, { [key]: value });
  }
  return {
    id: `q${String(seq)}`,
    sessionId: 's1',
    kind: 'anomaly',
    priority: 12,
    bytes: 10,
    createdAt: seq,
    attempts: 0,
    nextAttemptAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    retry: RETRY,
    request: {
      apiBase: 'https://api.example',
      token: 'tok',
      method: 'POST',
      path: '/v1/sessions/s1/anomalies',
      contentType: 'application/json',
      ...request,
    },
    ...over,
  };
}

type Reply = number | 'network';

function harness(replies: (url: string, init: RequestInit) => Reply = () => 200) {
  let clock = 1000;
  const queue = new Map<string, QueueItem>();
  const media = new Map<string, Blob>();
  const mediaSession = new Map<string, string>();
  const active: { id: string | undefined } = { id: 's1' };
  const requests: { url: string; key: string; body: unknown }[] = [];
  const scheduled: number[] = [];
  const fetchFn = vi.fn((url: string, init: RequestInit) => {
    requests.push({
      url,
      key: (init.headers as Record<string, string>)['idempotency-key'] ?? '',
      body: init.body,
    });
    const r = replies(url, init);
    return r === 'network'
      ? Promise.reject(new TypeError('Failed to fetch'))
      : Promise.resolve(new Response(null, { status: r }));
  });
  const uploader = new Uploader({
    queue: {
      list: () => Promise.resolve([...queue.values()]),
      put: (items) => {
        for (const i of items) queue.set(i.id, structuredClone(i));
        return Promise.resolve();
      },
      remove: (ids) => {
        for (const id of ids) queue.delete(id);
        return Promise.resolve();
      },
    },
    media: {
      get: (ref: { store: MediaStore; id: string }) => Promise.resolve(media.get(ref.id)),
      remove: (ref) => {
        media.delete(ref.id);
        return Promise.resolve();
      },
      list: () =>
        Promise.resolve(
          [...media.keys()].map((id) => ({
            store: 'frames' as const,
            id,
            sessionId: mediaSession.get(id) ?? 's1',
          })),
        ),
    },
    activeSessionId: () => Promise.resolve(active.id),
    fetch: fetchFn as unknown as typeof fetch,
    now: () => clock,
    rng: () => 0.5,
    schedule: (at) => scheduled.push(at),
  });
  return {
    uploader,
    queue,
    media,
    mediaSession,
    active,
    requests,
    scheduled,
    fetchFn,
    advance: (ms: number) => (clock += ms),
  };
}

describe('isSecureApi', () => {
  it('allows https and localhost http only', () => {
    expect(isSecureApi('https://api.example')).toBe(true);
    expect(isSecureApi('http://localhost:4401')).toBe(true);
    expect(isSecureApi('http://127.0.0.1:1')).toBe(true);
    expect(isSecureApi('http://api.example')).toBe(false);
    expect(isSecureApi('nonsense')).toBe(false);
  });
});

describe('Uploader', () => {
  it('sends queued items with the bearer token and the item id as idempotency key', async () => {
    const h = harness();
    const a = item();
    await h.uploader.enqueue([a]);
    await h.uploader.drain();
    expect(h.requests).toEqual([
      { url: 'https://api.example/v1/sessions/s1/anomalies', key: a.id, body: '{}' },
    ]);
    const init = h.fetchFn.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(h.queue.size).toBe(0);
  });

  it('sends in priority order and anomaly records before their evidence', async () => {
    const h = harness();
    const end = item({ kind: 'end', priority: 1 });
    const anomaly = item({ priority: 13, group: 'g' });
    const evidence = item({ kind: 'evidence', priority: 13, group: 'g', dependsOn: anomaly.id });
    const consent = item({ kind: 'consent', priority: 100 });
    await h.uploader.enqueue([end, evidence, anomaly, consent]);
    await h.uploader.drain();
    expect(h.requests.map((r) => r.key)).toEqual([consent.id, anomaly.id, evidence.id, end.id]);
  });

  it('retries network errors and 5xx with exponential backoff, then succeeds exactly once', async () => {
    let failures = 2;
    const h = harness(() => (failures-- > 0 ? 'network' : 200));
    const a = item();
    await h.uploader.enqueue([a]);
    await h.uploader.drain();
    expect(h.queue.get(a.id)).toMatchObject({ attempts: 1, nextAttemptAt: 1000 + 750 });
    expect(h.scheduled).toEqual([1750]);
    h.advance(750);
    await h.uploader.drain();
    expect(h.queue.get(a.id)).toMatchObject({ attempts: 2, nextAttemptAt: 1750 + 1500 });
    h.advance(1500);
    await h.uploader.drain();
    expect(h.queue.size).toBe(0);
    expect(h.requests.map((r) => r.key)).toEqual([a.id, a.id, a.id]); // same key every time
  });

  it('does not send an item before its retry time', async () => {
    const h = harness(() => 503);
    await h.uploader.enqueue([item()]);
    await h.uploader.drain();
    await h.uploader.drain();
    expect(h.requests).toHaveLength(1);
  });

  it('retries 408 and 429 but drops other 4xx, which can never succeed', async () => {
    const statuses = new Map([
      ['q-408', 408],
      ['q-429', 429],
      ['q-400', 400],
      ['q-401', 401],
    ]);
    const h = harness(
      (_u, init) =>
        statuses.get((init.headers as Record<string, string>)['idempotency-key'] ?? '') ?? 200,
    );
    await h.uploader.enqueue([...statuses.keys()].map((id) => item({ id })));
    await h.uploader.drain();
    expect([...h.queue.keys()].sort()).toEqual(['q-408', 'q-429']);
  });

  it('uploads media from IndexedDB and deletes the local copy once acknowledged', async () => {
    const h = harness();
    h.media.set('f1', new Blob([new Uint8Array(1234)], { type: 'image/jpeg' }));
    const frame = item(
      { kind: 'evidence' },
      {
        method: 'PUT',
        path: '/v1/sessions/s1/evidence/f1',
        contentType: 'image/jpeg',
        body: undefined,
        media: { store: 'frames', id: 'f1' },
      },
    );
    await h.uploader.enqueue([frame]);
    expect(h.queue.get(frame.id)?.bytes).toBe(1234); // sized from the stored blob
    await h.uploader.drain();
    expect(h.requests[0]?.body).toBeInstanceOf(Blob);
    expect(h.media.has('f1')).toBe(false);
  });

  it('keeps local media while its upload is failing', async () => {
    const h = harness(() => 'network');
    h.media.set('c1', new Blob([new Uint8Array(10)]));
    await h.uploader.enqueue([item({}, { media: { store: 'clips', id: 'c1' }, body: undefined })]);
    await h.uploader.drain();
    expect(h.media.has('c1')).toBe(true);
  });

  it('drops an item whose media is gone (already uploaded via a shared reference)', async () => {
    const h = harness();
    await h.uploader.enqueue([
      item({}, { media: { store: 'frames', id: 'gone' }, body: undefined }),
    ]);
    await h.uploader.drain();
    expect(h.requests).toEqual([]);
    expect(h.queue.size).toBe(0);
  });

  it('never sends to an insecure (non-localhost http) API', async () => {
    const h = harness();
    await h.uploader.enqueue([item({}, { apiBase: 'http://api.example' })]);
    await h.uploader.drain();
    expect(h.requests).toEqual([]);
    expect(h.queue.size).toBe(0);
  });

  it('purges expired items and their media without sending them', async () => {
    const h = harness();
    h.media.set('old', new Blob(['x']));
    await h.uploader.enqueue([
      item({ expiresAt: 500 }, { media: { store: 'frames', id: 'old' }, body: undefined }),
    ]);
    await h.uploader.drain();
    expect(h.requests).toEqual([]);
    expect(h.media.has('old')).toBe(false);
  });

  it('evicts lower-value groups when full, and refuses items it cannot fit', async () => {
    const h = harness(() => 'network');
    h.media.set('big-low', new Blob([new Uint8Array(6000)]));
    h.media.set('big-high', new Blob([new Uint8Array(6000)]));
    h.media.set('huge', new Blob([new Uint8Array(20_000)]));
    const low = item(
      { group: 'low', priority: 11 },
      { media: { store: 'frames', id: 'big-low' }, body: undefined },
    );
    const high = item(
      { group: 'high', priority: 13 },
      { media: { store: 'frames', id: 'big-high' }, body: undefined },
    );
    await h.uploader.enqueue([low]);
    expect(await h.uploader.enqueue([high])).toBe(true);
    expect([...h.queue.keys()]).toEqual([high.id]);
    expect(h.media.has('big-low')).toBe(false); // evicted with its group
    expect(
      await h.uploader.enqueue([
        item(
          { group: 'x', priority: 13 },
          { media: { store: 'frames', id: 'huge' }, body: undefined },
        ),
      ]),
    ).toBe(false);
    expect(h.media.has('huge')).toBe(false);
    expect(await h.uploader.enqueue([])).toBe(true);
  });

  it('sweeps media that belongs to no capturing session and is not queued', async () => {
    const h = harness(() => 'network');
    h.media.set('orphan-old', new Blob(['a'])); // ended session, never queued (late burst)
    h.mediaSession.set('orphan-old', 'old-session');
    h.media.set('queued-old', new Blob(['b'])); // ended session, still waiting to upload
    h.mediaSession.set('queued-old', 'old-session');
    h.media.set('live', new Blob(['c'])); // capturing session, window not packaged yet
    h.mediaSession.set('live', 's1');
    await h.uploader.enqueue([
      item({}, { media: { store: 'frames', id: 'queued-old' }, body: undefined }),
    ]);
    await h.uploader.drain();
    expect([...h.media.keys()].sort()).toEqual(['live', 'queued-old']);

    h.active.id = undefined; // the session ended: its unqueued media goes too
    await h.uploader.drain();
    expect([...h.media.keys()].sort()).toEqual(['queued-old']);
  });

  it('coalesces concurrent drains into one run that picks up new work', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness();
    h.fetchFn.mockImplementationOnce(() => gate.then(() => new Response(null, { status: 200 })));
    await h.uploader.enqueue([item()]);
    const first = h.uploader.drain();
    await h.uploader.enqueue([item()]);
    const second = h.uploader.drain(); // joins the running drain
    release();
    await Promise.all([first, second]);
    // (the gated first call bypasses the request recorder, so count calls on the mock)
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
    expect(h.queue.size).toBe(0);
  });
});
