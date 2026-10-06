import { DEFAULT_POLICY } from '@proctor/core';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './api-client';

function fakeFetch(status: number, body?: unknown) {
  return vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status })),
  );
}

describe('api client', () => {
  it('fetches and validates the session with the bearer token', async () => {
    const f = fakeFetch(200, { sessionId: 's1', policySnapshot: DEFAULT_POLICY });
    const info = await createApiClient(f as unknown as typeof fetch).fetchSession(
      'http://api.test/',
      'tok',
    );
    expect(info.sessionId).toBe('s1');
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe('http://api.test/v1/sessions/current');
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('rejects an invalid policy snapshot', async () => {
    const f = fakeFetch(200, { sessionId: 's1', policySnapshot: { weights: {} } });
    await expect(
      createApiClient(f as unknown as typeof fetch).fetchSession('http://api.test', 't'),
    ).rejects.toThrow();
  });

  it('posts consent and end as JSON to session-scoped paths', async () => {
    const f = fakeFetch(204);
    const client = createApiClient(f as unknown as typeof fetch);
    await client.postConsent('http://api.test', 't', 's/1', {
      decision: 'accepted',
      noticeVersion: 'v1',
      ts: 5,
    });
    await client.postEnd('http://api.test', 't', 's1', { ts: 6 });
    expect(f.mock.calls.map(([url]) => url)).toEqual([
      'http://api.test/v1/sessions/s%2F1/consents',
      'http://api.test/v1/sessions/s1/end',
    ]);
    const init = f.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      decision: 'accepted',
      noticeVersion: 'v1',
      ts: 5,
    });
  });

  it('accepts JSON bodies on 200 for posts and throws ApiError on HTTP errors', async () => {
    await createApiClient(fakeFetch(200, {}) as unknown as typeof fetch).postEnd(
      'http://api.test',
      't',
      's',
      { ts: 1 },
    );
    const err = await createApiClient(fakeFetch(401, { error: 'no' }) as unknown as typeof fetch)
      .fetchSession('http://api.test', 't')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });

  it('uses global fetch by default', async () => {
    const f = fakeFetch(204);
    vi.stubGlobal('fetch', f);
    try {
      await createApiClient().postEnd('http://api.test', 't', 's', { ts: 1 });
      expect(f).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
