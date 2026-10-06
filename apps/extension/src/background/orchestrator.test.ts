import { DEFAULT_POLICY, parsePolicy, type ConsentRecord } from '@proctor/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from './api-client';
import {
  Orchestrator,
  type ExternalSender,
  type InternalSender,
  type OrchestratorDeps,
  type StoredSession,
} from './orchestrator';

const EXAM = 'http://localhost:4400';
const API = 'http://localhost:4401';
const EXAM_TAB = 10;
const UI_TAB = 20;
const fromExam: ExternalSender = { url: `${EXAM}/exam`, tabId: EXAM_TAB };
const page: InternalSender = { kind: 'extension_page', tabId: UI_TAB };
const content: InternalSender = { kind: 'content_script', tabId: EXAM_TAB };
const START = { type: 'proctor:start', sessionToken: 'tok', apiBase: API };

function setup() {
  let stored: StoredSession | undefined;
  const calls: string[] = [];
  const consents: ConsentRecord[] = [];
  const api: ApiClient = {
    fetchSession: vi.fn(() =>
      Promise.resolve({ sessionId: 's1', policySnapshot: parsePolicy(DEFAULT_POLICY) }),
    ),
    postConsent: vi.fn((_b: string, _t: string, _id: string, record: ConsentRecord) => {
      consents.push(record);
      return Promise.resolve();
    }),
    postEnd: vi.fn(() => Promise.resolve()),
  };
  let clock = 1000;
  const deps = {
    config: { examOrigins: [EXAM], apiOrigins: [API] },
    store: {
      get: () => Promise.resolve(stored),
      set: (v: StoredSession) => {
        stored = structuredClone(v);
        return Promise.resolve();
      },
    },
    api,
    tabs: {
      openConsent: vi.fn((): Promise<number | undefined> => {
        calls.push('openConsent');
        return Promise.resolve(UI_TAB);
      }),
      showSetup: vi.fn((tab: number) => {
        calls.push(`showSetup:${String(tab)}`);
        return Promise.resolve();
      }),
      close: vi.fn((tab: number) => {
        calls.push(`close:${String(tab)}`);
        return Promise.resolve();
      }),
      focus: vi.fn((tab: number) => {
        calls.push(`focus:${String(tab)}`);
        return Promise.resolve();
      }),
    },
    capture: {
      start: vi.fn(() => {
        calls.push('capture.start');
        return Promise.resolve();
      }),
      stop: vi.fn(() => {
        calls.push('capture.stop');
        return Promise.resolve();
      }),
    },
    indicator: {
      show: vi.fn((on: boolean, tab: number) => {
        calls.push(`indicator:${String(on)}:${String(tab)}`);
        return Promise.resolve();
      }),
    },
    notifyPage: vi.fn((tab: number, event: string) => {
      calls.push(`page:${String(tab)}:${event}`);
      return Promise.resolve();
    }),
    now: () => (clock += 1000),
  } satisfies OrchestratorDeps;
  return { orch: new Orchestrator(deps), deps, calls, consents, stored: () => stored };
}

type Harness = ReturnType<typeof setup>;

async function toActive(h: Harness) {
  await h.orch.handleExternal(START, fromExam);
  await h.orch.handleInternal(
    { type: 'consent:decide', accepted: true, noticeVersion: 'v1' },
    page,
  );
  await h.orch.handleInternal(
    {
      type: 'setup:complete',
      result: { face: 'ready', mic: 'ready', performance: 'needs_attention' },
    },
    page,
  );
  await h.orch.handleInternal({ type: 'media:state', on: true }, page);
}

describe('session start', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('fetches the policy snapshot, stores the session and opens the consent notice', async () => {
    expect(await h.orch.handleExternal(START, fromExam)).toEqual({ ok: true, sessionId: 's1' });
    expect(h.deps.api.fetchSession).toHaveBeenCalledWith(API, 'tok');
    expect(h.stored()).toMatchObject({
      uiTabId: UI_TAB,
      session: { status: 'awaiting_consent', examTabId: EXAM_TAB },
    });
    expect(h.calls).toEqual(['openConsent']);
  });

  it('starts nothing before consent: no capture, no indicator, no page events', async () => {
    await h.orch.handleExternal(START, fromExam);
    expect(h.deps.capture.start).not.toHaveBeenCalled();
    expect(h.deps.indicator.show).not.toHaveBeenCalled();
    expect(h.deps.notifyPage).not.toHaveBeenCalled();
  });

  it('rejects requests from origins that are not configured exam sites', async () => {
    expect(await h.orch.handleExternal(START, { url: 'https://evil.example/', tabId: 1 })).toEqual({
      ok: false,
      error: 'origin_not_allowed',
    });
    expect(await h.orch.handleExternal(START, { url: `${EXAM}/`, tabId: undefined })).toMatchObject(
      {
        error: 'origin_not_allowed',
      },
    );
  });

  it('rejects API hosts that are not allow-listed', async () => {
    expect(
      await h.orch.handleExternal({ ...START, apiBase: 'https://evil.example' }, fromExam),
    ).toEqual({
      ok: false,
      error: 'api_not_allowed',
    });
    expect(h.deps.api.fetchSession).not.toHaveBeenCalled();
  });

  it('rejects malformed requests', async () => {
    expect(await h.orch.handleExternal({ type: 'proctor:start' }, fromExam)).toMatchObject({
      error: 'invalid_request',
    });
  });

  it('reports a failed session fetch and stores nothing', async () => {
    vi.mocked(h.deps.api.fetchSession).mockRejectedValueOnce(new Error('401'));
    expect(await h.orch.handleExternal(START, fromExam)).toMatchObject({
      error: 'session_fetch_failed',
    });
    expect(h.stored()).toBeUndefined();
  });

  it('refuses a second start while a session is in progress, allows one after it ends', async () => {
    await h.orch.handleExternal(START, fromExam);
    expect(await h.orch.handleExternal(START, fromExam)).toMatchObject({
      error: 'session_in_progress',
    });
    await h.orch.handleExternal({ type: 'proctor:end' }, fromExam);
    expect(await h.orch.handleExternal(START, fromExam)).toMatchObject({ ok: true });
  });

  it('works when the consent tab id is unknown', async () => {
    vi.mocked(h.deps.tabs.openConsent).mockResolvedValueOnce(undefined);
    await h.orch.handleExternal(START, fromExam);
    expect(h.stored()?.uiTabId).toBeUndefined();
    await h.orch.handleInternal(
      { type: 'consent:decide', accepted: true, noticeVersion: 'v1' },
      page,
    );
    expect(h.deps.tabs.showSetup).toHaveBeenCalledWith(UI_TAB); // falls back to the sender tab
  });

  it('reports status', async () => {
    expect(await h.orch.handleExternal({ type: 'proctor:status' }, fromExam)).toEqual({
      ok: true,
      status: 'none',
    });
    await h.orch.handleExternal(START, fromExam);
    expect(await h.orch.handleExternal({ type: 'proctor:status' }, fromExam)).toEqual({
      ok: true,
      status: 'awaiting_consent',
      sessionId: 's1',
    });
  });
});

describe('consent', () => {
  let h: Harness;
  beforeEach(async () => {
    h = setup();
    await h.orch.handleExternal(START, fromExam);
    h.calls.length = 0;
  });

  it('gives the consent page the policy snapshot', async () => {
    expect(await h.orch.handleInternal({ type: 'consent:get' }, page)).toEqual({
      ok: true,
      policy: parsePolicy(DEFAULT_POLICY),
    });
  });

  it('declining records the decision, closes the notice and starts nothing', async () => {
    const res = await h.orch.handleInternal(
      { type: 'consent:decide', accepted: false, noticeVersion: 'v1' },
      page,
    );
    expect(res).toEqual({ ok: true });
    expect(h.consents).toEqual([
      { decision: 'declined', noticeVersion: 'v1', ts: expect.any(Number) as number },
    ]);
    expect(h.stored()?.session.status).toBe('consent_declined');
    expect(h.calls).toEqual([
      `close:${String(UI_TAB)}`,
      `focus:${String(EXAM_TAB)}`,
      `page:${String(EXAM_TAB)}:consent_declined`,
    ]);
    expect(h.deps.capture.start).not.toHaveBeenCalled();
    expect(h.deps.indicator.show).not.toHaveBeenCalled();
  });

  it('declining succeeds locally even if the API is down', async () => {
    vi.mocked(h.deps.api.postConsent).mockRejectedValueOnce(new Error('offline'));
    expect(
      await h.orch.handleInternal(
        { type: 'consent:decide', accepted: false, noticeVersion: 'v1' },
        page,
      ),
    ).toEqual({
      ok: true,
    });
    expect(h.stored()?.session.status).toBe('consent_declined');
  });

  it('nothing can start after declining', async () => {
    await h.orch.handleInternal(
      { type: 'consent:decide', accepted: false, noticeVersion: 'v1' },
      page,
    );
    expect(
      await h.orch.handleInternal(
        { type: 'setup:complete', result: { face: 'ready', mic: 'ready', performance: 'ready' } },
        page,
      ),
    ).toMatchObject({ ok: false, error: 'wrong_state' });
    expect(await h.orch.handleInternal({ type: 'media:state', on: true }, page)).toMatchObject({
      ok: false,
    });
    expect(h.deps.capture.start).not.toHaveBeenCalled();
    expect(h.deps.capture.stop).toHaveBeenCalled(); // stray media is shut down
    expect(h.stored()?.session.mediaOn).toBe(false);
  });

  it('accepting stores consent server-side first, then shows the setup check', async () => {
    const res = await h.orch.handleInternal(
      { type: 'consent:decide', accepted: true, noticeVersion: 'v1' },
      page,
    );
    expect(res).toEqual({ ok: true });
    expect(h.consents[0]?.decision).toBe('accepted');
    expect(h.stored()?.session).toMatchObject({
      status: 'setup',
      consentAt: expect.any(Number) as number,
    });
    expect(h.calls).toEqual([`showSetup:${String(UI_TAB)}`]);
    expect(h.deps.capture.start).not.toHaveBeenCalled();
  });

  it('does not advance if consent cannot be stored', async () => {
    vi.mocked(h.deps.api.postConsent).mockRejectedValueOnce(new Error('offline'));
    expect(
      await h.orch.handleInternal(
        { type: 'consent:decide', accepted: true, noticeVersion: 'v1' },
        page,
      ),
    ).toEqual({
      ok: false,
      error: 'api_error',
    });
    expect(h.stored()?.session.status).toBe('awaiting_consent');
  });

  it('closing the notice tab counts as declining', async () => {
    await h.orch.handleTabRemoved(UI_TAB);
    expect(h.consents[0]?.decision).toBe('declined');
    expect(h.stored()?.session.status).toBe('consent_declined');
    expect(h.calls).toContain(`page:${String(EXAM_TAB)}:consent_declined`);
    expect(h.calls).not.toContain(`close:${String(UI_TAB)}`); // already closed
  });

  it('only extension pages may decide, and only once', async () => {
    const decide = { type: 'consent:decide', accepted: true, noticeVersion: 'v1' };
    expect(await h.orch.handleInternal(decide, content)).toEqual({
      ok: false,
      error: 'not_allowed',
    });
    expect(
      await h.orch.handleInternal(decide, { kind: 'unknown', tabId: undefined }),
    ).toMatchObject({ ok: false });
    await h.orch.handleInternal(decide, page);
    expect(await h.orch.handleInternal(decide, page)).toEqual({ ok: false, error: 'wrong_state' });
    expect(await h.orch.handleInternal({ type: 'consent:get' }, page)).toEqual({
      ok: false,
      error: 'wrong_state',
    });
  });
});

describe('setup and capture', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('starts capture after setup, then turns the indicator on and tells the page it is ready', async () => {
    await toActive(h);
    expect(h.calls).toEqual([
      'openConsent',
      `showSetup:${String(UI_TAB)}`,
      `close:${String(UI_TAB)}`,
      `focus:${String(EXAM_TAB)}`,
      'capture.start',
      `indicator:true:${String(EXAM_TAB)}`,
      `page:${String(EXAM_TAB)}:ready`,
    ]);
    expect(h.stored()).toMatchObject({
      readySent: true,
      session: { status: 'active', mediaOn: true },
    });
    expect(h.stored()?.uiTabId).toBeUndefined();
  });

  it('gives the setup page the policy only during setup', async () => {
    await h.orch.handleExternal(START, fromExam);
    expect(await h.orch.handleInternal({ type: 'setup:get' }, page)).toEqual({
      ok: false,
      error: 'wrong_state',
    });
    await h.orch.handleInternal(
      { type: 'consent:decide', accepted: true, noticeVersion: 'v1' },
      page,
    );
    expect(await h.orch.handleInternal({ type: 'setup:get' }, page)).toMatchObject({ ok: true });
  });

  it('reports a capture start failure', async () => {
    h.deps.capture.start.mockRejectedValueOnce(new Error('no offscreen'));
    await h.orch.handleExternal(START, fromExam);
    await h.orch.handleInternal(
      { type: 'consent:decide', accepted: true, noticeVersion: 'v1' },
      page,
    );
    expect(
      await h.orch.handleInternal(
        { type: 'setup:complete', result: { face: 'ready', mic: 'ready', performance: 'ready' } },
        page,
      ),
    ).toEqual({ ok: false, error: 'capture_failed' });
  });

  it('tracks media turning off and on again, sending ready only once', async () => {
    await toActive(h);
    await h.orch.handleInternal({ type: 'media:state', on: false }, page);
    await h.orch.handleInternal({ type: 'media:state', on: false }, page); // no-op
    await h.orch.handleInternal({ type: 'media:state', on: true }, page);
    expect(h.calls.slice(-2)).toEqual([
      `indicator:false:${String(EXAM_TAB)}`,
      `indicator:true:${String(EXAM_TAB)}`,
    ]);
    expect(h.calls.filter((c) => c.endsWith(':ready'))).toHaveLength(1);
  });

  it('answers the content script indicator query for the exam tab only', async () => {
    expect(await h.orch.handleInternal({ type: 'indicator:get' }, content)).toEqual({
      ok: true,
      on: false,
    });
    await toActive(h);
    expect(await h.orch.handleInternal({ type: 'indicator:get' }, content)).toEqual({
      ok: true,
      on: true,
    });
    expect(
      await h.orch.handleInternal({ type: 'indicator:get' }, { kind: 'content_script', tabId: 99 }),
    ).toEqual({
      ok: true,
      on: false,
    });
    expect(await h.orch.handleInternal({ type: 'indicator:get' }, page)).toEqual({
      ok: false,
      error: 'not_allowed',
    });
  });

  it('closing the setup tab ends the session', async () => {
    await h.orch.handleExternal(START, fromExam);
    await h.orch.handleInternal(
      { type: 'consent:decide', accepted: true, noticeVersion: 'v1' },
      page,
    );
    await h.orch.handleTabRemoved(UI_TAB);
    expect(h.stored()?.session.status).toBe('ended');
    expect(h.calls).not.toContain(`close:${String(UI_TAB)}`);
  });

  it('rejects malformed internal messages', async () => {
    expect(await h.orch.handleInternal({ type: 'media:state', on: 'yes' }, page)).toEqual({
      ok: false,
      error: 'invalid_request',
    });
    expect(await h.orch.handleInternal({ type: 'consent:get' }, page)).toEqual({
      ok: false,
      error: 'wrong_state',
    });
  });
});

describe('ending', () => {
  let h: Harness;
  beforeEach(async () => {
    h = setup();
    await toActive(h);
    h.calls.length = 0;
  });

  it('end stops capture, clears the indicator, records the end and tells the page', async () => {
    expect(await h.orch.handleExternal({ type: 'proctor:end' }, fromExam)).toEqual({
      ok: true,
      sessionId: 's1',
    });
    expect(h.calls).toEqual([
      'capture.stop',
      `indicator:false:${String(EXAM_TAB)}`,
      `page:${String(EXAM_TAB)}:ended`,
    ]);
    expect(h.deps.api.postEnd).toHaveBeenCalledWith(API, 'tok', 's1', {
      ts: expect.any(Number) as number,
    });
    expect(h.stored()?.session).toMatchObject({ status: 'ended', mediaOn: false });
  });

  it('end succeeds locally even if the API is down', async () => {
    h.deps.api.postEnd = vi.fn(() => Promise.reject(new Error('offline')));
    expect(await h.orch.handleExternal({ type: 'proctor:end' }, fromExam)).toMatchObject({
      ok: true,
    });
    expect(h.stored()?.session.status).toBe('ended');
  });

  it('only the exam tab can end its session', async () => {
    expect(
      await h.orch.handleExternal({ type: 'proctor:end' }, { url: `${EXAM}/other`, tabId: 99 }),
    ).toEqual({
      ok: false,
      error: 'no_session',
    });
  });

  it('closing the exam tab ends the session and turns media off', async () => {
    await h.orch.handleTabRemoved(EXAM_TAB);
    expect(h.calls).toContain('capture.stop');
    expect(h.stored()?.session.status).toBe('ended');
    await h.orch.handleTabRemoved(EXAM_TAB); // already ended: no-op
    await h.orch.handleTabRemoved(12345); // unrelated tab: no-op
    expect(h.calls.filter((c) => c === 'capture.stop')).toHaveLength(1);
  });

  it('ending twice reports no session', async () => {
    await h.orch.handleExternal({ type: 'proctor:end' }, fromExam);
    expect(await h.orch.handleExternal({ type: 'proctor:end' }, fromExam)).toEqual({
      ok: false,
      error: 'no_session',
    });
  });
});

describe('service worker restarts', () => {
  it('continues from stored state with a fresh orchestrator', async () => {
    const h = setup();
    await h.orch.handleExternal(START, fromExam);
    const revived = new Orchestrator(
      (h.orch as unknown as { deps: OrchestratorDeps }).deps, // same storage, new instance
    );
    expect(await revived.handleInternal({ type: 'consent:get' }, page)).toMatchObject({ ok: true });
    await revived.handleInternal(
      { type: 'consent:decide', accepted: true, noticeVersion: 'v1' },
      page,
    );
    expect(h.stored()?.session.status).toBe('setup');
  });

  it('serialises concurrent calls so a double start cannot race', async () => {
    const h = setup();
    const [a, b] = await Promise.all([
      h.orch.handleExternal(START, fromExam),
      h.orch.handleExternal(START, fromExam),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(h.deps.tabs.openConsent).toHaveBeenCalledTimes(1);
  });

  it('keeps processing after a task throws', async () => {
    const h = setup();
    h.deps.tabs.openConsent.mockRejectedValueOnce(new Error('tabs down'));
    await expect(h.orch.handleExternal(START, fromExam)).rejects.toThrow('tabs down');
    expect(await h.orch.handleExternal({ type: 'proctor:status' }, fromExam)).toMatchObject({
      ok: true,
    });
  });
});
