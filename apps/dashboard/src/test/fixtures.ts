import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  computeRisk,
  DEFAULT_POLICY,
  mergeViolations,
  REPORT_LIMITATIONS,
  VIOLATION_LABELS,
  type Anomaly,
  type EvidenceRef,
  type ViolationType,
} from '@proctor/core';
import { render, type RenderResult } from '@testing-library/react';
import { createElement } from 'react';
import { vi } from 'vitest';
import { App } from '../App';
import { tokenStore } from '../api/client';
import type { Me, SessionList, SessionReport } from '../api/types';
import { AuthProvider } from '../auth';

export const T0 = Date.parse('2026-10-01T09:00:00Z');
const MIN = 60_000;
export const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function anomaly(
  type: ViolationType,
  at: number,
  confidence = 1,
  media?: EvidenceRef['kind'],
): Anomaly {
  const ts = T0 + at * MIN;
  const evidence: EvidenceRef[] = [{ id: `seq-${type}-${String(at)}`, kind: 'event_sequence', ts }];
  if (media) evidence.push({ id: `${media}-${type}-${String(at)}`, kind: media, ts });
  return { id: `a-${type}-${String(at)}`, type, ts, confidence, evidence };
}

/** The PRD sample (49.0 Medium risk) as the API reports it, computed with core. */
export function prdReport(): SessionReport {
  const anomalies = [
    anomaly('tab_switch_or_blur', 3),
    anomaly('phone_detected', 7, 1, 'frame'),
    anomaly('tab_switch_or_blur', 12),
    anomaly('phone_detected', 18, 1, 'frame'),
    anomaly('tab_switch_or_blur', 24),
    anomaly('copy_paste', 27),
    anomaly('speech_detected', 31, 1, 'audio'),
    anomaly('speech_detected', 38, 2 / 3, 'audio'),
  ];
  const violations = mergeViolations(anomalies, DEFAULT_POLICY);
  const scored = computeRisk(violations, DEFAULT_POLICY);
  const points = new Map(scored.violations.map((v) => [v.violationId, v.points]));
  return {
    session: {
      id: SESSION_ID,
      examId: null,
      candidateRef: 'demo-candidate-1',
      status: 'ended',
      startedAt: new Date(T0).toISOString(),
      endedAt: new Date(T0 + 45 * MIN).toISOString(),
      policyVersionId: null,
    },
    risk: scored.risk,
    band: scored.band,
    categories: scored.categories,
    violations: violations.map((v) => ({
      ...v,
      label: VIOLATION_LABELS[v.type],
      points: points.get(v.id) ?? 0,
      evidence: v.evidence.map((e) => ({ ...e, uploaded: true })),
    })),
    policySnapshot: DEFAULT_POLICY,
    reproducible: true,
    limitations: [...REPORT_LIMITATIONS],
    generatedAt: new Date(T0 + 50 * MIN).toISOString(),
  };
}

export const SESSION_LIST: SessionList = {
  total: 2,
  sessions: [
    {
      id: SESSION_ID,
      examId: null,
      candidateRef: 'demo-candidate-1',
      status: 'ended',
      startedAt: new Date(T0).toISOString(),
      endedAt: new Date(T0 + 45 * MIN).toISOString(),
      risk: 49,
      band: 'medium',
      violationCount: 8,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      examId: null,
      candidateRef: 'demo-candidate-3',
      status: 'ended',
      startedAt: new Date(T0).toISOString(),
      endedAt: null,
      risk: 4,
      band: 'low',
      violationCount: 2,
    },
  ],
};

export const REVIEWER: Me = {
  id: 'u1',
  email: 'reviewer@a.test',
  role: 'reviewer',
  organisationId: 'o1',
};
export const ADMIN: Me = { ...REVIEWER, id: 'u2', email: 'admin@a.test', role: 'admin' };

type Handler = (init: RequestInit, url: URL) => unknown;

/**
 * Stubs fetch with handlers keyed by "METHOD /path". A handler may return a Response (sent as
 * is) or any value (sent as JSON 200). Unknown routes answer 404. Returns the call log.
 */
export function mockApi(handlers: Record<string, Handler>): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://dashboard.test');
      const key = `${init.method ?? 'GET'} ${url.pathname}`;
      calls.push(`${key}${url.search}`);
      const handler = handlers[key];
      if (!handler) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'not found' }), { status: 404 }),
        );
      }
      const result = handler(init, url);
      return Promise.resolve(
        result instanceof Response
          ? result
          : new Response(JSON.stringify(result), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
      );
    }),
  );
  return { calls };
}

/** Renders the whole app, signed in (with a stored token) unless `signedIn` is false. */
export function renderApp({
  path = '/',
  signedIn = true,
}: { path?: string; signedIn?: boolean } = {}): RenderResult {
  if (signedIn) tokenStore.set('put_test');
  window.history.replaceState(null, '', path);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AuthProvider, null, createElement(App)),
    ),
  );
}
