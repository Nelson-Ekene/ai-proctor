import { expect, type BrowserContext, type Page } from '@playwright/test';
import { DEFAULT_POLICY, type Policy, type ViolationType } from '@proctor/core';
import { acceptAndCompleteSetup } from '../fixtures.ts';
import type { ProxyEntry } from '../fullstack-setup.ts';
import {
  FULLSTACK_API_URL,
  FULLSTACK_HOST_URL,
  FULLSTACK_PROXY_URL,
  SEED_PASSWORD,
} from '../settings.ts';

// Helpers for the full-stack suites: talk to the real API as the seeded admin/reviewer and drive
// the demo exam site in the extension's browser.

export async function login(email: string): Promise<string> {
  const res = await fetch(`${FULLSTACK_API_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: SEED_PASSWORD }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

export async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${FULLSTACK_API_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  expect(res.ok, `${path}: ${String(res.status)}`).toBe(true);
  return (await res.json()) as T;
}

/** Short windows and quick retries, so a test session finishes in seconds (like tok-fastupload). */
export const FAST_POLICY: Policy = {
  ...DEFAULT_POLICY,
  sampling: { framesPerWindow: 5, windowSeconds: 5 },
  gazeAway: { ...DEFAULT_POLICY.gazeAway, sustainedSeconds: 2 },
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

export async function setPolicy(policy: Policy): Promise<void> {
  const admin = await login('admin@proctor.test');
  await api(admin, '/v1/policies', { method: 'PUT', body: JSON.stringify({ policy }) });
}

/** Opens the demo exam site, starts an exam and completes consent and the setup check. */
export async function startExam(
  context: BrowserContext,
  extensionId: string,
  candidateRef: string,
): Promise<Page> {
  const host = await context.newPage();
  await host.goto(`${FULLSTACK_HOST_URL}/?ext=${extensionId}`);
  await host.fill('#candidate', candidateRef);
  const consentTab = context.waitForEvent('page');
  await host.click('#start');
  const consent = await consentTab;
  await consent.waitForURL(/consent\.html/);
  await acceptAndCompleteSetup(consent);
  await expect(host.locator('#status')).toHaveText('proctoring active', { timeout: 30_000 });
  await host.bringToFront();
  return host;
}

export interface ReportView {
  session: { id: string; status: string; candidateRef: string };
  risk: number;
  band: string;
  reproducible: boolean;
  violations: {
    type: ViolationType;
    evidence: { id: string; kind: string; uploaded: boolean }[];
  }[];
}

export async function sessionId(token: string, candidateRef: string): Promise<string> {
  let id: string | undefined;
  await expect
    .poll(async () => {
      const list = await api<{ sessions: { id: string; candidateRef: string }[] }>(
        token,
        '/v1/sessions?limit=200',
      );
      id = list.sessions.find((s) => s.candidateRef === candidateRef)?.id;
      return id;
    })
    .toBeTruthy();
  return id ?? '';
}

export async function proxyLog(): Promise<ProxyEntry[]> {
  return (await (await fetch(`${FULLSTACK_PROXY_URL}/__proxy/log`)).json()) as ProxyEntry[];
}

export async function resetProxy(): Promise<void> {
  await fetch(`${FULLSTACK_PROXY_URL}/__proxy/reset`, { method: 'POST' });
}
