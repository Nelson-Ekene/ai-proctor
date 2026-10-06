import {
  SessionInfoSchema,
  type ConsentRecord,
  type EndSession,
  type SessionInfo,
} from '@proctor/core';

export interface ApiClient {
  fetchSession(apiBase: string, token: string): Promise<SessionInfo>;
  postConsent(
    apiBase: string,
    token: string,
    sessionId: string,
    record: ConsentRecord,
  ): Promise<void>;
  postEnd(apiBase: string, token: string, sessionId: string, body: EndSession): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Transport timeout (network hygiene, not a product threshold). */
const REQUEST_TIMEOUT_MS = 15_000;

export function createApiClient(fetchFn: typeof fetch = (...args) => fetch(...args)): ApiClient {
  async function call(
    apiBase: string,
    token: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const url = `${apiBase.replace(/\/+$/, '')}${path}`;
    const res = await fetchFn(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new ApiError(res.status, `${String(res.status)} from ${path}`);
    return res.status === 204 ? undefined : res.json();
  }

  return {
    async fetchSession(apiBase, token) {
      return SessionInfoSchema.parse(await call(apiBase, token, '/v1/sessions/current'));
    },
    async postConsent(apiBase, token, sessionId, record) {
      await call(apiBase, token, `/v1/sessions/${encodeURIComponent(sessionId)}/consents`, record);
    },
    async postEnd(apiBase, token, sessionId, body) {
      await call(apiBase, token, `/v1/sessions/${encodeURIComponent(sessionId)}/end`, body);
    },
  };
}
