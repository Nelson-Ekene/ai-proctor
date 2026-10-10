import {
  AnomalySchema,
  DEFAULT_POLICY,
  parsePolicy,
  priorityFor,
  type ConsentRecord,
  type EvidenceRef,
  type PendingAnomaly,
} from '@proctor/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueItem } from '../shared/evidence-store';
import type { ApiClient } from './api-client';
import {
  Orchestrator,
  rulesTickMinutes,
  type ExternalSender,
  type InternalSender,
  type OrchestratorDeps,
  type StoredSession,
} from './orchestrator';

const EXAM = 'http://localhost:4400';
const API = 'http://localhost:4401';
const EXAM_TAB = 10;
const UI_TAB = 20;
const EXAM_WINDOW = 1;
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
  let ids = 0;
  const queued: QueueItem[] = [];
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
      windowOf: vi.fn((): Promise<number | undefined> => Promise.resolve(EXAM_WINDOW)),
    },
    monitor: {
      start: vi.fn((tab: number, pingMs: number, tickMinutes: number) => {
        calls.push(`monitor.start:${String(tab)}:${String(pingMs)}:${String(tickMinutes)}`);
        return Promise.resolve();
      }),
      stop: vi.fn((tab: number) => {
        calls.push(`monitor.stop:${String(tab)}`);
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
    uploads: {
      enqueue: vi.fn((items: QueueItem[]) => {
        queued.push(...structuredClone(items));
        return Promise.resolve(true);
      }),
      kick: vi.fn(),
    },
    offscreen: {
      burst: vi.fn((): Promise<EvidenceRef[]> => Promise.resolve([])),
      flush: vi.fn((): Promise<PendingAnomaly[]> => Promise.resolve([])),
    },
    newId: () => `id${String(++ids)}`,
    now: () => (clock += 1000),
  } satisfies OrchestratorDeps;
  return {
    orch: new Orchestrator(deps),
    deps,
    calls,
    consents,
    queued,
    /** Decisions sent directly (accept) or queued (decline). */
    queuedBodies: (kind: string) =>
      queued
        .filter((q) => q.kind === kind)
        .map((q) => JSON.parse(q.request.body ?? 'null') as unknown),
    stored: () => stored,
    /** Moves the clock forward (each now() call also adds 1 s). */
    advance: (ms: number) => (clock += ms),
  };
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
    // The decline record goes through the persistent upload queue, not a direct request.
    expect(h.consents).toEqual([]);
    expect(h.queuedBodies('consent')).toEqual([
      { decision: 'declined', noticeVersion: 'v1', ts: expect.any(Number) as number },
    ]);
    expect(h.queued[0]).toMatchObject({
      kind: 'consent',
      priority: 100,
      request: { method: 'POST', path: '/v1/sessions/s1/consents', apiBase: API, token: 'tok' },
    });
    expect(h.deps.uploads.kick).toHaveBeenCalled();
    expect(h.stored()?.session.status).toBe('consent_declined');
    expect(h.calls).toEqual([
      `close:${String(UI_TAB)}`,
      `focus:${String(EXAM_TAB)}`,
      `page:${String(EXAM_TAB)}:consent_declined`,
    ]);
    expect(h.deps.capture.start).not.toHaveBeenCalled();
    expect(h.deps.indicator.show).not.toHaveBeenCalled();
  });

  it('declining succeeds locally even if the record cannot be queued', async () => {
    h.deps.uploads.enqueue.mockRejectedValueOnce(new Error('storage full'));
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
    expect(h.queuedBodies('consent')).toMatchObject([{ decision: 'declined' }]);
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
      `monitor.start:${String(EXAM_TAB)}:5000:0.5`,
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

  it('answers the content script state query for the exam tab only', async () => {
    expect(await h.orch.handleInternal({ type: 'content:get' }, content)).toEqual({
      ok: true,
      on: false,
    });
    await toActive(h);
    expect(await h.orch.handleInternal({ type: 'content:get' }, content)).toEqual({
      ok: true,
      on: true,
      monitorPingMs: 5000,
    });
    expect(
      await h.orch.handleInternal({ type: 'content:get' }, { kind: 'content_script', tabId: 99 }),
    ).toEqual({
      ok: true,
      on: false,
    });
    expect(await h.orch.handleInternal({ type: 'content:get' }, page)).toEqual({
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
      `monitor.stop:${String(EXAM_TAB)}`,
      `indicator:false:${String(EXAM_TAB)}`,
      `page:${String(EXAM_TAB)}:ended`,
    ]);
    // The end record is queued (lowest priority: sent after all evidence), not sent directly.
    expect(h.deps.api.postEnd).not.toHaveBeenCalled();
    expect(h.queuedBodies('end')).toEqual([{ ts: expect.any(Number) as number }]);
    expect(h.queued.find((q) => q.kind === 'end')).toMatchObject({
      priority: 1,
      request: { method: 'POST', path: '/v1/sessions/s1/end' },
    });
    expect(h.deps.offscreen.flush).toHaveBeenCalled();
    expect(h.stored()?.session).toMatchObject({ status: 'ended', mediaOn: false });
  });

  it('end succeeds locally even if queueing fails', async () => {
    h.deps.uploads.enqueue.mockRejectedValue(new Error('storage full'));
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

describe('browser rule engine (phase 3)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = setup();
    await toActive(h);
  });

  /** Sends a raw event from the exam tab's content script, stamped "now". */
  const rule = (event: Record<string, unknown>, sender: InternalSender = content) =>
    h.orch.handleInternal({ type: 'rules:event', event: { ts: h.advance(100), ...event } }, sender);
  const anomalyTypes = () => h.stored()?.anomalies?.map((a) => a.type) ?? [];

  it('initialises the engine and the exam window when the session becomes active', () => {
    expect(h.stored()).toMatchObject({ examWindowId: EXAM_WINDOW, anomalies: [] });
    expect(h.stored()?.rules?.log).toEqual([]);
  });

  it('detects all five browser violation types from page events and the clock', async () => {
    await rule({ kind: 'fullscreenchange', isFullscreen: true });
    await rule({ kind: 'fullscreenchange', isFullscreen: false });
    await rule({ kind: 'visibilitychange', hidden: true });
    await rule({ kind: 'visibilitychange', hidden: false });
    await rule({ kind: 'copy' });
    await rule({ kind: 'paste' });
    await rule({ kind: 'refresh_key' });
    await rule({ kind: 'page_reload' });
    h.advance(61_000);
    await rule({ kind: 'tick' });
    expect(new Set(anomalyTypes())).toEqual(
      new Set([
        'fullscreen_exit',
        'tab_switch_or_blur',
        'copy_paste',
        'refresh_attempt',
        'inactivity',
      ]),
    );
    expect(h.stored()?.anomalies?.every((a) => a.confidence === 1)).toBe(true);
  });

  it('keeps a rolling log of type + timestamp covering the last 60 s', async () => {
    await rule({ kind: 'copy' });
    h.advance(30_000);
    await rule({ kind: 'paste' });
    let log = h.stored()?.rules?.log ?? [];
    expect(log.map((e) => e.type)).toEqual(['copy', 'paste']);
    h.advance(31_000);
    await rule({ kind: 'cut' });
    log = h.stored()?.rules?.log ?? [];
    // 'copy' aged out; the idle gap also produced an inactivity entry.
    expect(log.map((e) => e.type)).toEqual(['paste', 'inactivity', 'cut']);
    const now = h.stored()?.rules?.now ?? 0;
    expect(log.every((e) => now - e.ts <= 60_000)).toBe(true);
  });

  it('stores no URLs, page text or keystrokes even if a sender tries to include them', async () => {
    const leaky = {
      url: 'https://exam.example/q/42?token=abc',
      text: 'SECRET-ANSWER',
      key: 'TYPED-KEY-MARKER',
      code: 'KeyV',
      clipboardData: 'SECRET-PASTE',
      title: 'Question 42',
    };
    for (const kind of ['copy', 'paste', 'refresh_key', 'blur', 'activity']) {
      expect(await rule({ kind, ...leaky })).toEqual({ ok: true });
    }
    const stored = h.stored();
    for (const entry of stored?.rules?.log ?? [])
      expect(Object.keys(entry).sort()).toEqual(['ts', 'type']);
    const json = JSON.stringify({ rules: stored?.rules, anomalies: stored?.anomalies });
    for (const value of Object.values(leaky)) expect(json).not.toContain(value);
  });

  it('accepts rule events only from the exam tab while the session is active', async () => {
    expect(await rule({ kind: 'copy' }, { kind: 'content_script', tabId: 99 })).toEqual({
      ok: false,
      error: 'not_allowed',
    });
    expect(await rule({ kind: 'copy' }, page)).toEqual({ ok: false, error: 'not_allowed' });
    expect(await rule({ kind: 'keylogger' })).toEqual({ ok: false, error: 'invalid_request' });
    expect(anomalyTypes()).toEqual([]);

    const fresh = setup();
    await fresh.orch.handleExternal(START, fromExam);
    expect(
      await fresh.orch.handleInternal(
        { type: 'rules:event', event: { kind: 'copy', ts: 1 } },
        content,
      ),
    ).toEqual({ ok: false, error: 'wrong_state' });
  });

  it('turns chrome.tabs activation in the exam window into tab-switch signals', async () => {
    await h.orch.handleTabActivated(99, EXAM_WINDOW);
    // The content script reports the same departure: still one anomaly.
    await rule({ kind: 'visibilitychange', hidden: true });
    await h.orch.handleTabActivated(EXAM_TAB, EXAM_WINDOW);
    await rule({ kind: 'visibilitychange', hidden: false });
    await h.orch.handleTabActivated(55, 2); // another window: exam tab unaffected
    expect(anomalyTypes()).toEqual(['tab_switch_or_blur']);
    expect(h.stored()?.rules?.log.map((e) => e.type)).toEqual([
      'visibility_hidden',
      'visibility_visible',
    ]);
  });

  it('turns chrome.windows focus changes into blur/focus signals', async () => {
    await h.orch.handleWindowFocus(-1); // browser lost focus (WINDOW_ID_NONE)
    await h.orch.handleWindowFocus(EXAM_WINDOW);
    await h.orch.handleWindowFocus(2); // another browser window
    expect(anomalyTypes()).toEqual(['tab_switch_or_blur', 'tab_switch_or_blur']);
  });

  it('uses the alarm tick as the inactivity fallback', async () => {
    h.advance(61_000);
    await h.orch.handleRulesTick();
    expect(anomalyTypes()).toEqual(['inactivity']);
  });

  it('does nothing before the session is active or after it ends', async () => {
    const early = setup();
    await early.orch.handleExternal(START, fromExam);
    await early.orch.handleWindowFocus(-1);
    await early.orch.handleTabActivated(99, EXAM_WINDOW);
    await early.orch.handleRulesTick();
    expect(early.stored()?.anomalies).toBeUndefined();

    await h.orch.handleExternal({ type: 'proctor:end' }, fromExam);
    expect(h.calls).toContain(`monitor.stop:${String(EXAM_TAB)}`);
    expect(await rule({ kind: 'copy' })).toEqual({ ok: false, error: 'wrong_state' });
    await h.orch.handleWindowFocus(-1);
    expect(anomalyTypes()).toEqual([]);
  });

  it('ignores window focus when the exam window is unknown', async () => {
    const x = setup();
    x.deps.tabs.windowOf.mockResolvedValueOnce(undefined);
    await toActive(x);
    expect(x.stored()?.examWindowId).toBeUndefined();
    await x.orch.handleWindowFocus(-1);
    expect(x.stored()?.anomalies).toEqual([]);
  });

  it('survives a service worker restart mid-session', async () => {
    await rule({ kind: 'fullscreenchange', isFullscreen: true });
    const revived = new Orchestrator((h.orch as unknown as { deps: OrchestratorDeps }).deps);
    await revived.handleInternal(
      {
        type: 'rules:event',
        event: { kind: 'fullscreenchange', ts: h.advance(100), isFullscreen: false },
      },
      content,
    );
    expect(anomalyTypes()).toEqual(['fullscreen_exit']);
  });

  it('creates engine state lazily if it is missing', async () => {
    const stored = h.stored();
    if (!stored) throw new Error('no session');
    const { rules: _rules, anomalies: _anomalies, ...rest } = stored;
    await h.deps.store.set(rest);
    await rule({ kind: 'copy' });
    expect(anomalyTypes()).toEqual(['copy_paste']);
  });
});

describe('video sampling messages (phase 4)', () => {
  const offscreen: InternalSender = { kind: 'extension_page', tabId: undefined };
  const phone = {
    type: 'phone_detected',
    ts: 5000,
    confidence: 0.8,
    evidence: [
      { id: 'f1', kind: 'frame', ts: 5000 },
      { id: 'f2', kind: 'frame', ts: 6000 },
    ],
  };

  it('gives the offscreen document the policy and session id only while active', async () => {
    const h = setup();
    await h.orch.handleExternal(START, fromExam);
    expect(await h.orch.handleInternal({ type: 'video:config' }, offscreen)).toEqual({
      ok: false,
      error: 'wrong_state',
    });
    await toActive(h);
    expect(await h.orch.handleInternal({ type: 'video:config' }, offscreen)).toMatchObject({
      ok: true,
      sessionId: 's1',
      policy: { sampling: { framesPerWindow: 5 } },
    });
  });

  it('stores video anomalies together with their frame evidence', async () => {
    const h = setup();
    await toActive(h);
    expect(
      await h.orch.handleInternal({ type: 'video:anomalies', anomalies: [phone] }, offscreen),
    ).toEqual({ ok: true });
    expect(h.stored()?.anomalies).toMatchObject([phone]);
  });

  it('rejects non-video anomalies, other senders and inactive sessions', async () => {
    const h = setup();
    await toActive(h);
    const browserType = { ...phone, type: 'copy_paste' };
    expect(
      await h.orch.handleInternal({ type: 'video:anomalies', anomalies: [browserType] }, offscreen),
    ).toEqual({ ok: false, error: 'invalid_request' });
    expect(
      await h.orch.handleInternal({ type: 'video:anomalies', anomalies: [phone] }, content),
    ).toEqual({ ok: false, error: 'not_allowed' });
    expect(
      await h.orch.handleInternal({ type: 'video:anomalies', anomalies: [] }, offscreen),
    ).toEqual({ ok: false, error: 'invalid_request' });
    await h.orch.handleExternal({ type: 'proctor:end' }, fromExam);
    expect(
      await h.orch.handleInternal({ type: 'video:anomalies', anomalies: [phone] }, offscreen),
    ).toEqual({ ok: false, error: 'wrong_state' });
    expect(h.stored()?.anomalies).toEqual([]);
  });

  it('records video sampling metadata (slow-device degradation)', async () => {
    const h = setup();
    const meta = { degraded: true, framesPerWindow: 3, medianInferenceMs: 400 };
    await h.orch.handleExternal(START, fromExam);
    expect(await h.orch.handleInternal({ type: 'video:meta', meta }, offscreen)).toEqual({
      ok: false,
      error: 'wrong_state',
    });
    await toActive(h);
    await h.orch.handleInternal({ type: 'video:meta', meta }, offscreen);
    expect(h.stored()?.videoMeta).toEqual(meta);
  });
});

describe('audio monitoring messages (phase 5)', () => {
  const offscreen: InternalSender = { kind: 'extension_page', tabId: undefined };
  const speech = {
    type: 'speech_detected',
    ts: 7000,
    confidence: 0.86,
    evidence: [{ id: 'c1', kind: 'audio', ts: 6000 }],
  };

  it('stores audio anomalies with their clip evidence while active', async () => {
    const h = setup();
    await toActive(h);
    expect(
      await h.orch.handleInternal({ type: 'audio:anomalies', anomalies: [speech] }, offscreen),
    ).toEqual({ ok: true });
    expect(h.stored()?.anomalies).toMatchObject([speech]);
  });

  it('records that the microphone is being monitored, only while active', async () => {
    const h = setup();
    const meta = { listening: true, multiVoiceMethod: 'pitch-cluster-heuristic-v1' };
    await h.orch.handleExternal(START, fromExam);
    expect(await h.orch.handleInternal({ type: 'audio:meta', meta }, offscreen)).toEqual({
      ok: false,
      error: 'wrong_state',
    });
    await toActive(h);
    expect(await h.orch.handleInternal({ type: 'audio:meta', meta }, offscreen)).toEqual({
      ok: true,
    });
    expect(h.stored()?.audioMeta).toEqual(meta);
  });

  it('accepts only audio findings on the audio channel, and only while active', async () => {
    const h = setup();
    await h.orch.handleExternal(START, fromExam);
    expect(
      await h.orch.handleInternal({ type: 'audio:anomalies', anomalies: [speech] }, offscreen),
    ).toEqual({ ok: false, error: 'wrong_state' });
    await toActive(h);
    const notAudio = { ...speech, type: 'phone_detected' };
    expect(
      await h.orch.handleInternal({ type: 'audio:anomalies', anomalies: [notAudio] }, offscreen),
    ).toEqual({ ok: false, error: 'invalid_request' });
    expect(
      await h.orch.handleInternal({ type: 'video:anomalies', anomalies: [speech] }, offscreen),
    ).toEqual({ ok: false, error: 'invalid_request' });
    expect(
      await h.orch.handleInternal({ type: 'audio:anomalies', anomalies: [speech] }, content),
    ).toEqual({ ok: false, error: 'not_allowed' });
    expect(h.stored()?.anomalies).toEqual([]);
  });
});

describe('the session never waits on the network (stability-loop regression)', () => {
  const never = <T>() => new Promise<T>(() => undefined);

  it('end makes no network call and notifies the page before queueing anything', async () => {
    const h = setup();
    await toActive(h);
    h.deps.uploads.enqueue.mockImplementation(never);
    h.calls.length = 0;
    void h.orch.handleExternal({ type: 'proctor:end' }, fromExam);
    await vi.waitFor(() => {
      expect(h.calls).toContain(`page:${String(EXAM_TAB)}:ended`);
    });
    expect(h.deps.api.postEnd).not.toHaveBeenCalled();
    expect(h.stored()?.session.status).toBe('ended');
  });

  it('decline notifies the page before queueing its record', async () => {
    const h = setup();
    await h.orch.handleExternal(START, fromExam);
    h.deps.uploads.enqueue.mockImplementation(never);
    void h.orch.handleInternal(
      { type: 'consent:decide', accepted: false, noticeVersion: 'v1' },
      page,
    );
    await vi.waitFor(() => {
      expect(h.calls).toContain(`page:${String(EXAM_TAB)}:consent_declined`);
    });
    expect(h.deps.api.postConsent).not.toHaveBeenCalled();
  });

  it('persists "ended" before teardown, so a stalled teardown cannot leave it active', async () => {
    const h = setup();
    await toActive(h);
    h.deps.capture.stop.mockImplementation(never);
    void h.orch.handleExternal({ type: 'proctor:end' }, fromExam);
    await vi.waitFor(() => {
      expect(h.stored()?.session.status).toBe('ended');
    });
  });

  it('settled() waits for background work (bursts) and logs its failures', async () => {
    const h = setup();
    const log = vi.fn();
    (h.orch as unknown as { deps: OrchestratorDeps }).deps.log = log;
    await toActive(h);
    h.deps.offscreen.burst.mockRejectedValueOnce(new Error('offscreen gone'));
    await h.orch.handleInternal(
      { type: 'rules:event', event: { kind: 'copy', ts: h.advance(0) } },
      content,
    );
    await h.orch.settled();
    expect(log).toHaveBeenCalledWith('burst failed', expect.any(Error));
  });

  it('traces every queued task with its duration', async () => {
    const h = setup();
    const trace = vi.fn();
    (h.orch as unknown as { deps: OrchestratorDeps }).deps.trace = trace;
    await h.orch.handleExternal({ type: 'proctor:status' }, fromExam);
    await h.orch.handleInternal(42, page);
    const lines = trace.mock.calls.map(([m]) => String(m));
    expect(lines).toContain('task external:proctor:status start');
    expect(lines.some((l) => /^task external:proctor:status done in \d+ms$/.test(l))).toBe(true);
    expect(lines).toContain('task internal:unknown start');
  });
});

describe('capture packages and the upload queue (phase 6)', () => {
  const offscreen: InternalSender = { kind: 'extension_page', tabId: undefined };
  let h: Harness;
  beforeEach(async () => {
    h = setup();
    await toActive(h);
  });

  const copy = () =>
    h.orch.handleInternal(
      { type: 'rules:event', event: { kind: 'copy', ts: h.advance(0) } },
      content,
    );
  const tick = () =>
    h.orch.handleInternal(
      { type: 'rules:event', event: { kind: 'tick', ts: h.advance(0) } },
      content,
    );
  const anomalyItems = () => h.queued.filter((q) => q.kind === 'anomaly');

  it('gives each anomaly an id, a capture window and a snapshot of the preceding events', async () => {
    await h.orch.handleInternal(
      { type: 'rules:event', event: { kind: 'paste', ts: h.advance(0) } },
      content,
    );
    h.advance(1000);
    await copy();
    const [, second] = h.stored()?.anomalies ?? [];
    expect(second).toMatchObject({
      type: 'copy_paste',
      id: expect.stringMatching(/^id\d+$/) as string,
    });
    expect(second?.closesAt).toBe((second?.ts ?? 0) + 15_000);
    expect(second?.before.map((e) => e.type)).toEqual(['paste', 'copy']);
  });

  it('asks for a burst of frames for anomalies without frames and attaches them', async () => {
    const frames = [{ id: 'b1', kind: 'frame' as const, ts: 1 }];
    h.deps.offscreen.burst.mockResolvedValueOnce(frames);
    await copy();
    await h.orch.settled();
    expect(h.deps.offscreen.burst).toHaveBeenCalledTimes(1);
    expect(h.stored()?.anomalies?.[0]?.evidence).toEqual(frames);
  });

  it('does not ask for a burst for webcam anomalies, which already carry frames', async () => {
    const phone = {
      type: 'phone_detected',
      ts: h.advance(0),
      confidence: 0.8,
      evidence: [{ id: 'f1', kind: 'frame', ts: 1 }],
    };
    await h.orch.handleInternal({ type: 'video:anomalies', anomalies: [phone] }, offscreen);
    expect(h.deps.offscreen.burst).not.toHaveBeenCalled();
  });

  it('packages an anomaly only after its capture window closes', async () => {
    await copy();
    expect(anomalyItems()).toEqual([]);
    h.advance(16_000);
    await tick();
    expect(anomalyItems()).toHaveLength(1);
    expect(h.stored()?.anomalies?.[0]).toMatchObject({ packaged: true, before: [] });
    expect(h.deps.uploads.kick).toHaveBeenCalled();
    await tick(); // already packaged: not queued twice
    expect(anomalyItems()).toHaveLength(1);
  });

  it('queues the anomaly record, then its evidence (event sequence and frames) as one group', async () => {
    h.deps.offscreen.burst.mockResolvedValueOnce([{ id: 'b1', kind: 'frame', ts: 1 }]);
    await copy();
    await h.orch.settled();
    h.advance(16_000);
    await tick();
    const [record] = anomalyItems();
    const anomaly = AnomalySchema.parse(JSON.parse(record?.request.body ?? ''));
    expect(anomaly.type).toBe('copy_paste');
    expect(anomaly.evidence.map((e) => e.kind)).toEqual(['frame', 'event_sequence']);
    expect(record).toMatchObject({
      id: anomaly.id,
      group: anomaly.id,
      priority: priorityFor('anomaly', 'low'),
      request: { method: 'POST', path: '/v1/sessions/s1/anomalies' },
    });
    const evidence = h.queued.filter((q) => q.kind === 'evidence');
    expect(evidence.map((e) => e.id).sort()).toEqual(anomaly.evidence.map((e) => e.id).sort());
    for (const e of evidence) expect(e).toMatchObject({ dependsOn: anomaly.id, group: anomaly.id });
    const frame = evidence.find((e) => e.id === 'b1');
    expect(frame?.request).toMatchObject({
      method: 'PUT',
      path: '/v1/sessions/s1/evidence/b1',
      contentType: 'image/jpeg',
      media: { store: 'frames', id: 'b1' },
    });
    const seq = evidence.find((e) => e.request.contentType === 'application/json');
    expect(JSON.parse(seq?.request.body ?? '')).toMatchObject({ events: [{ type: 'copy' }] });
  });

  it('links an overlapping speech clip to other anomalies in the window', async () => {
    const speech = {
      type: 'speech_detected',
      ts: h.advance(0),
      confidence: 0.9,
      evidence: [{ id: 'c1', kind: 'audio', ts: h.advance(0) }],
    };
    await h.orch.handleInternal({ type: 'audio:anomalies', anomalies: [speech] }, offscreen);
    await copy();
    h.advance(16_000);
    await tick();
    const bodies = anomalyItems().map((q) => AnomalySchema.parse(JSON.parse(q.request.body ?? '')));
    const copyRecord = bodies.find((b) => b.type === 'copy_paste');
    expect(copyRecord?.evidence.map((e) => e.id)).toContain('c1');
    const clipItems = h.queued.filter((q) => q.id === 'c1');
    expect(clipItems[0]?.request).toMatchObject({
      contentType: 'audio/wav',
      media: { store: 'clips', id: 'c1' },
    });
  });

  it('prioritises severe anomalies and expires items after retentionDays', async () => {
    const phone = {
      type: 'phone_detected',
      ts: h.advance(0),
      confidence: 0.8,
      evidence: [{ id: 'f1', kind: 'frame', ts: 1 }],
    };
    await h.orch.handleInternal({ type: 'video:anomalies', anomalies: [phone] }, offscreen);
    h.advance(16_000);
    await tick();
    const [record] = anomalyItems();
    expect(record?.priority).toBe(priorityFor('anomaly', 'high'));
    expect(record?.expiresAt).toBe((record?.createdAt ?? 0) + 30 * 24 * 60 * 60 * 1000);
    expect(record?.retry).toEqual(DEFAULT_POLICY.upload);
  });

  it('keeps an anomaly unpackaged if queueing fails, so it is retried later', async () => {
    await copy();
    h.advance(16_000);
    h.deps.uploads.enqueue.mockRejectedValueOnce(new Error('storage busy'));
    await expect(tick()).rejects.toThrow('storage busy');
    expect(h.stored()?.anomalies?.[0]?.packaged).toBeUndefined();
    await tick();
    expect(h.stored()?.anomalies?.[0]?.packaged).toBe(true);
  });

  it('at session end packages open windows, includes a flushed speech clip and queues the end last', async () => {
    h.deps.offscreen.flush.mockResolvedValueOnce([
      {
        type: 'speech_detected',
        ts: h.advance(0),
        confidence: 0.8,
        evidence: [{ id: 'c9', kind: 'audio', ts: 1 }],
      },
    ]);
    await copy(); // window still open
    await h.orch.handleExternal({ type: 'proctor:end' }, fromExam);
    expect(
      anomalyItems()
        .map((q) => JSON.parse(q.request.body ?? '{}') as { type: string })
        .map((b) => b.type)
        .sort(),
    ).toEqual(['copy_paste', 'speech_detected']);
    expect(h.stored()?.anomalies?.every((a) => a.packaged)).toBe(true);
    expect(h.queued.at(-1)?.kind).toBe('end');
    expect(h.deps.offscreen.burst).toHaveBeenCalledTimes(1); // the copy, not the flushed clip
  });

  it('ignores burst frames that arrive after the anomaly was packaged', async () => {
    let release: (v: EvidenceRef[]) => void = () => undefined;
    h.deps.offscreen.burst.mockImplementationOnce(
      () =>
        new Promise<EvidenceRef[]>((r) => {
          release = r;
        }),
    );
    await copy();
    await h.orch.handleExternal({ type: 'proctor:end' }, fromExam); // packages immediately
    release([{ id: 'late', kind: 'frame', ts: 1 }]);
    await h.orch.settled();
    expect(h.stored()?.anomalies?.[0]?.evidence ?? []).toEqual([]);
  });
});

describe('rulesTickMinutes', () => {
  it('never goes below the Chrome alarm minimum and follows the inactivity threshold', () => {
    const policy = parsePolicy(DEFAULT_POLICY);
    expect(rulesTickMinutes(policy)).toBe(0.5);
    expect(rulesTickMinutes({ ...policy, inactivity: { seconds: 600, pingSeconds: 5 } })).toBe(5);
  });
});
