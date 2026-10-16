import type {
  AuditEntry,
  EventSequence,
  EvidenceUrl,
  Exam,
  LoginResponse,
  Me,
  Metrics,
  Organisation,
  PolicyView,
  SessionList,
  SessionReport,
} from './types';
import type { Policy } from '@proctor/core';

/** An HTTP error from the API, with its status and the server's message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const TOKEN_KEY = 'proctor.token';

/** The login token lives in sessionStorage: per tab, gone when the tab closes. */
export const tokenStore = {
  get(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string | null): void {
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // storage unavailable: the session lasts until reload
    }
  },
};

/** Called when the API answers 401 (expired or revoked token). */
let onUnauthorised: () => void = () => undefined;
export function setUnauthorisedHandler(handler: () => void): void {
  onUnauthorised = handler;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const token = tokenStore.get();
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // not JSON
    }
    if (res.status === 401 && path !== '/v1/auth/login') onUnauthorised();
    throw new ApiError(res.status, message);
  }
  return res;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await request(path, init);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const enc = encodeURIComponent;

export interface SessionFilters {
  band?: string | undefined;
  status?: string | undefined;
  examId?: string | undefined;
  limit?: number;
  offset?: number;
}

export const api = {
  login: (email: string, password: string) =>
    json<LoginResponse>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () => json<undefined>('/v1/auth/logout', { method: 'POST' }),
  me: () => json<Me>('/v1/me'),
  sessions: (f: SessionFilters = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '') q.set(k, String(v));
    const query = q.toString();
    return json<SessionList>(`/v1/sessions${query ? `?${query}` : ''}`);
  },
  report: (id: string) => json<SessionReport>(`/v1/sessions/${enc(id)}/report`),
  evidenceUrl: (sessionId: string, evidenceId: string) =>
    json<EvidenceUrl>(`/v1/sessions/${enc(sessionId)}/evidence/${enc(evidenceId)}/url`),
  eventSequence: (sessionId: string, evidenceId: string) =>
    json<EventSequence>(`/v1/sessions/${enc(sessionId)}/evidence/${enc(evidenceId)}/events`),
  /** Downloads an export (audited server-side) as a Blob. */
  exportReport: async (id: string, format: 'pdf' | 'json') =>
    (await request(`/v1/sessions/${enc(id)}/report.${format}`)).blob(),
  exams: () => json<Exam[]>('/v1/exams'),
  policy: (examId?: string) =>
    json<PolicyView>(`/v1/policies${examId ? `?examId=${enc(examId)}` : ''}`),
  savePolicy: (policy: Policy, examId?: string) =>
    json<{ id: string; version: number }>('/v1/policies', {
      method: 'PUT',
      body: JSON.stringify({ policy, ...(examId ? { examId } : {}) }),
    }),
  organisation: () => json<Organisation>('/v1/organisation'),
  metrics: () => json<Metrics>('/v1/metrics'),
  audit: (limit = 100) => json<AuditEntry[]>(`/v1/audit?limit=${String(limit)}`),
  /** Reports visible review time; keepalive so it survives leaving the page. */
  reviewTime: async (sessionId: string, ms: number) => {
    await request(`/v1/sessions/${enc(sessionId)}/review-time`, {
      method: 'POST',
      body: JSON.stringify({ ms: Math.round(ms) }),
      keepalive: true,
    });
  },
  /** Permanently deletes a session, its data and its evidence (admin only). */
  deleteSession: (sessionId: string) =>
    json<undefined>(`/v1/sessions/${enc(sessionId)}`, { method: 'DELETE' }),
  removeOverride: (examId: string) =>
    json<{ version: number }>(`/v1/policies/exams/${enc(examId)}`, { method: 'DELETE' }),
};
