import {
  ExternalRequestSchema,
  captureAllowed,
  createRuleEngineState,
  isTerminal,
  stepRuleEngine,
  transition,
  categoryOf,
  type ConsentRecord,
  type PendingAnomaly,
  type ExternalErrorCode,
  type ExternalResponse,
  type Policy,
  type RawBrowserEvent,
  type RuleEngineState,
  type SdkEventName,
  type SessionEvent,
  type SessionState,
} from '@proctor/core';
import { isAllowedOrigin, type ExtensionConfig } from '../config';
import {
  InternalRequestSchema,
  NOTICE_VERSION,
  type InternalError,
  type AudioMetaRecord,
  type InternalResponse,
  type VideoMetaRecord,
} from '../messages';
import type { ApiClient } from './api-client';

/** Everything the service worker persists. Lives in chrome.storage.session (memory only). */
export interface StoredSession {
  session: SessionState;
  /** Tab showing the consent/setup pages, if open. */
  uiTabId?: number;
  readySent?: boolean;
  /** Window holding the exam tab, for chrome.windows focus signals. */
  examWindowId?: number;
  /** Browser rule engine state, including the rolling type+timestamp log (Phase 3). */
  rules?: RuleEngineState;
  /** Anomalies detected but not yet packaged/uploaded (Phase 6 drains this). */
  anomalies?: PendingAnomaly[];
  /** Webcam sampling state, e.g. reduced rate on a slow device (Phase 4). */
  videoMeta?: VideoMetaRecord;
  /** Microphone monitoring state (Phase 5). */
  audioMeta?: AudioMetaRecord;
}

/** chrome.alarms cannot fire more often than every 30 s. */
export const CHROME_MIN_ALARM_MINUTES = 0.5;

/** Fallback tick for the inactivity timer when the page's own ticks are throttled. */
export function rulesTickMinutes(policy: Policy): number {
  return Math.max(CHROME_MIN_ALARM_MINUTES, policy.inactivity.seconds / 2 / 60);
}

export interface SessionStore {
  get(): Promise<StoredSession | undefined>;
  set(value: StoredSession): Promise<void>;
}

export interface OrchestratorDeps {
  config: ExtensionConfig;
  store: SessionStore;
  api: ApiClient;
  tabs: {
    /** Opens the consent page and returns its tab id. */
    openConsent(): Promise<number | undefined>;
    showSetup(tabId: number): Promise<void>;
    close(tabId: number): Promise<void>;
    focus(tabId: number): Promise<void>;
    windowOf(tabId: number): Promise<number | undefined>;
  };
  /** Browser monitoring in the exam tab (content script) plus the fallback tick alarm. */
  monitor: {
    start(examTabId: number, pingMs: number, tickMinutes: number): Promise<void>;
    stop(examTabId: number): Promise<void>;
  };
  /** Offscreen document that owns the camera/microphone stream. */
  capture: { start(): Promise<void>; stop(): Promise<void> };
  /** Badge + in-page overlay. */
  indicator: { show(on: boolean, examTabId: number): Promise<void> };
  /** Relays an SDK event to the exam tab's content script. Must not throw. */
  notifyPage(tabId: number, event: SdkEventName, sessionId: string): Promise<void>;
  now(): number;
  log?(message: string, error?: unknown): void;
  /** Debug-level tracing of queue tasks and teardown steps (diagnostics). */
  trace?(message: string): void;
}

export interface ExternalSender {
  url: string | undefined;
  tabId: number | undefined;
}

export interface InternalSender {
  kind: 'extension_page' | 'content_script' | 'unknown';
  tabId: number | undefined;
}

/** Message type for tracing only (the payload is validated later). */
function requestType(raw: unknown): string {
  const type = (raw as { type?: unknown } | null)?.type;
  return typeof type === 'string' ? type : 'unknown';
}

const fail = (error: ExternalErrorCode): ExternalResponse => ({ ok: false, error });
const internalFail = (error: InternalError): InternalResponse => ({ ok: false, error });

/**
 * Service-worker orchestrator. Stateless between calls (state is in the store) so it survives
 * MV3 worker restarts. Calls are serialised so interleaved Chrome events cannot race.
 */
export class Orchestrator {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly backgroundWork = new Set<Promise<void>>();

  constructor(private readonly deps: OrchestratorDeps) {}

  /**
   * Serialises a task. Each task is traced (start + duration) so a stalled step shows up in
   * the worker console. Keep slow, best-effort network work out of here: see `background`.
   */
  private run<T>(name: string, task: () => Promise<T>): Promise<T> {
    const traced = async () => {
      const started = performance.now();
      this.deps.trace?.(`task ${name} start`);
      try {
        return await task();
      } finally {
        this.deps.trace?.(`task ${name} done in ${(performance.now() - started).toFixed(0)}ms`);
      }
    };
    const result = this.queue.then(traced, traced);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /**
   * Best-effort work (e.g. uploading an end or decline record) that must not hold the queue:
   * a slow backend would otherwise delay every other event, including "end".
   */
  private background(name: string, work: () => Promise<void>): void {
    const job = work()
      .catch((error: unknown) => this.deps.log?.(`${name} failed`, error))
      .finally(() => this.backgroundWork.delete(job));
    this.backgroundWork.add(job);
  }

  /** Resolves when all background work has finished (tests, shutdown). */
  async settled(): Promise<void> {
    await Promise.all([...this.backgroundWork]);
  }

  /** Runs one step of a multi-step task and traces its duration (pinpoints slow Chrome APIs). */
  private async step<T>(label: string, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await work();
    } finally {
      this.deps.trace?.(`${label} ${(performance.now() - started).toFixed(0)}ms`);
    }
  }

  handleExternal(raw: unknown, sender: ExternalSender): Promise<ExternalResponse> {
    return this.run(`external:${requestType(raw)}`, async () => {
      const { config, store, api } = this.deps;
      if (sender.tabId === undefined || !isAllowedOrigin(sender.url, config.examOrigins)) {
        return fail('origin_not_allowed');
      }
      const parsed = ExternalRequestSchema.safeParse(raw);
      if (!parsed.success) return fail('invalid_request');
      const request = parsed.data;
      const stored = await store.get();
      const live = stored && !isTerminal(stored.session.status) ? stored : undefined;

      switch (request.type) {
        case 'proctor:status':
          return stored
            ? { ok: true, status: stored.session.status, sessionId: stored.session.sessionId }
            : { ok: true, status: 'none' };

        case 'proctor:end':
          if (!live || live.session.examTabId !== sender.tabId) return fail('no_session');
          await this.end(live);
          return { ok: true, sessionId: live.session.sessionId };

        case 'proctor:start': {
          if (live) return fail('session_in_progress');
          if (!isAllowedOrigin(request.apiBase, config.apiOrigins)) return fail('api_not_allowed');
          let info;
          try {
            info = await api.fetchSession(request.apiBase, request.sessionToken);
          } catch (error) {
            this.deps.log?.('session fetch failed', error);
            return fail('session_fetch_failed');
          }
          const session: SessionState = {
            status: 'awaiting_consent',
            sessionId: info.sessionId,
            sessionToken: request.sessionToken,
            apiBase: request.apiBase,
            examTabId: sender.tabId,
            policy: info.policySnapshot,
            startedAt: this.deps.now(),
            mediaOn: false,
          };
          await store.set({ session });
          const uiTabId = await this.deps.tabs.openConsent();
          await store.set(uiTabId === undefined ? { session } : { session, uiTabId });
          return { ok: true, sessionId: session.sessionId };
        }
      }
    });
  }

  handleInternal(raw: unknown, sender: InternalSender): Promise<InternalResponse> {
    return this.run(`internal:${requestType(raw)}`, async () => {
      const parsed = InternalRequestSchema.safeParse(raw);
      if (!parsed.success) return internalFail('invalid_request');
      const request = parsed.data;
      const stored = await this.deps.store.get();

      if (request.type === 'content:get' || request.type === 'rules:event') {
        if (sender.kind !== 'content_script') return internalFail('not_allowed');
        const ours = stored?.session.examTabId === sender.tabId ? stored : undefined;
        const monitoring = ours?.session.status === 'active';
        if (request.type === 'content:get') {
          return {
            ok: true,
            on: ours?.session.mediaOn === true,
            ...(monitoring
              ? { monitorPingMs: ours.session.policy.inactivity.pingSeconds * 1000 }
              : {}),
          };
        }
        if (!ours) return internalFail('not_allowed');
        if (!monitoring) return internalFail('wrong_state');
        await this.applyRuleEvent(ours, request.event);
        return { ok: true };
      }
      // Everything else is privileged: only the extension's own pages may send it.
      if (sender.kind !== 'extension_page') return internalFail('not_allowed');
      if (!stored) return internalFail('wrong_state');
      const { session } = stored;

      switch (request.type) {
        case 'consent:get':
          return session.status === 'awaiting_consent'
            ? { ok: true, policy: session.policy }
            : internalFail('wrong_state');

        case 'consent:decide':
          if (session.status !== 'awaiting_consent') return internalFail('wrong_state');
          return request.accepted
            ? this.accept(stored, request.noticeVersion, sender.tabId)
            : this.decline(stored, request.noticeVersion);

        case 'setup:get':
          return session.status === 'setup'
            ? { ok: true, policy: session.policy }
            : internalFail('wrong_state');

        case 'setup:complete':
          return this.completeSetup(stored);

        case 'media:state':
          return this.mediaChanged(stored, request.on);

        case 'video:config':
          return session.status === 'active'
            ? { ok: true, policy: session.policy, sessionId: session.sessionId }
            : internalFail('wrong_state');

        case 'video:anomalies':
        case 'audio:anomalies': {
          if (session.status !== 'active') return internalFail('wrong_state');
          // Each channel may only report its own category (webcam / microphone findings).
          const category = request.type === 'video:anomalies' ? 'video' : 'audio';
          if (request.anomalies.some((a) => categoryOf(a.type) !== category)) {
            return internalFail('invalid_request');
          }
          await this.deps.store.set({
            ...stored,
            anomalies: [...(stored.anomalies ?? []), ...request.anomalies],
          });
          return { ok: true };
        }

        case 'video:meta':
          if (session.status !== 'active') return internalFail('wrong_state');
          await this.deps.store.set({ ...stored, videoMeta: request.meta });
          return { ok: true };

        case 'audio:meta':
          if (session.status !== 'active') return internalFail('wrong_state');
          await this.deps.store.set({ ...stored, audioMeta: request.meta });
          return { ok: true };

        case 'diag':
          this.deps.trace?.(`offscreen: ${request.message}`);
          return { ok: true };
      }
    });
  }

  handleTabRemoved(tabId: number): Promise<void> {
    return this.run('tabRemoved', async () => {
      const stored = await this.deps.store.get();
      if (!stored || isTerminal(stored.session.status)) return;
      if (tabId === stored.session.examTabId) {
        await this.end(stored);
      } else if (tabId === stored.uiTabId) {
        const { uiTabId: _closed, ...rest } = stored;
        // Closing the consent notice counts as declining; closing setup ends the session.
        if (stored.session.status === 'awaiting_consent') await this.decline(rest, NOTICE_VERSION);
        else await this.end(rest);
      }
    });
  }

  /** chrome.tabs.onActivated: another tab in the exam window hides the exam tab. */
  handleTabActivated(tabId: number, windowId: number): Promise<void> {
    return this.run('tabActivated', async () => {
      const stored = await this.monitored();
      if (!stored || windowId !== stored.examWindowId) return;
      await this.applyRuleEvent(stored, {
        kind: 'visibilitychange',
        ts: this.deps.now(),
        hidden: tabId !== stored.session.examTabId,
      });
    });
  }

  /** chrome.windows.onFocusChanged: any window other than the exam's (or none) is a blur. */
  handleWindowFocus(windowId: number): Promise<void> {
    return this.run('windowFocus', async () => {
      const stored = await this.monitored();
      if (!stored || stored.examWindowId === undefined) return;
      await this.applyRuleEvent(stored, {
        kind: windowId === stored.examWindowId ? 'focus' : 'blur',
        ts: this.deps.now(),
      });
    });
  }

  /** chrome.alarms fallback tick for the inactivity timer. */
  handleRulesTick(): Promise<void> {
    return this.run('rulesTick', async () => {
      const stored = await this.monitored();
      if (stored) await this.applyRuleEvent(stored, { kind: 'tick', ts: this.deps.now() });
    });
  }

  private async monitored(): Promise<StoredSession | undefined> {
    const stored = await this.deps.store.get();
    return stored?.session.status === 'active' ? stored : undefined;
  }

  private async applyRuleEvent(stored: StoredSession, event: RawBrowserEvent): Promise<void> {
    const { session } = stored;
    const { state, anomalies } = stepRuleEngine(
      stored.rules ?? createRuleEngineState(session.activeAt ?? this.deps.now()),
      event,
      session.policy,
    );
    await this.deps.store.set({
      ...stored,
      rules: state,
      anomalies: [...(stored.anomalies ?? []), ...anomalies],
    });
  }

  private async save(stored: StoredSession, event: SessionEvent): Promise<StoredSession> {
    const next = { ...stored, session: transition(stored.session, event) };
    await this.deps.store.set(next);
    return next;
  }

  private consentRecord(decision: ConsentRecord['decision'], noticeVersion: string): ConsentRecord {
    return { decision, noticeVersion, ts: this.deps.now() };
  }

  private async accept(
    stored: StoredSession,
    noticeVersion: string,
    senderTab: number | undefined,
  ) {
    const { session } = stored;
    try {
      // Consent must be recorded server-side before anything else happens.
      await this.deps.api.postConsent(
        session.apiBase,
        session.sessionToken,
        session.sessionId,
        this.consentRecord('accepted', noticeVersion),
      );
    } catch (error) {
      this.deps.log?.('consent upload failed', error);
      return internalFail('api_error');
    }
    const next = await this.save(stored, { type: 'consent_accepted', ts: this.deps.now() });
    const tab = next.uiTabId ?? senderTab;
    if (tab !== undefined) await this.deps.tabs.showSetup(tab);
    return { ok: true } as const;
  }

  private async decline(stored: StoredSession, noticeVersion: string) {
    const { session } = stored;
    // Declining always succeeds locally and is applied first; recording it is best effort and
    // happens outside the queue (Phase 6 routes it through the offline queue).
    const record = this.consentRecord('declined', noticeVersion);
    const next = await this.save(stored, { type: 'consent_declined', ts: this.deps.now() });
    if (next.uiTabId !== undefined) await this.deps.tabs.close(next.uiTabId);
    await this.deps.tabs.focus(session.examTabId);
    await this.deps.notifyPage(session.examTabId, 'consent_declined', session.sessionId);
    this.background('decline upload', () =>
      this.deps.api.postConsent(session.apiBase, session.sessionToken, session.sessionId, record),
    );
    return { ok: true } as const;
  }

  private async completeSetup(stored: StoredSession): Promise<InternalResponse> {
    if (stored.session.status !== 'setup') return internalFail('wrong_state');
    const activated = transition(stored.session, {
      type: 'setup_completed',
      ts: this.deps.now(),
    });
    const { uiTabId, ...rest } = stored;
    const { examTabId, policy } = activated;
    const examWindowId = await this.step('setup: windowOf', () =>
      this.deps.tabs.windowOf(examTabId),
    );
    await this.deps.store.set({
      ...rest,
      session: activated,
      rules: createRuleEngineState(activated.activeAt ?? this.deps.now()),
      anomalies: [],
      ...(examWindowId === undefined ? {} : { examWindowId }),
    });
    if (uiTabId !== undefined) {
      await this.step('setup: ui.close', () => this.deps.tabs.close(uiTabId));
    }
    await this.step('setup: focus', () => this.deps.tabs.focus(examTabId));
    await this.step('setup: monitor.start', () =>
      this.deps.monitor.start(
        examTabId,
        policy.inactivity.pingSeconds * 1000,
        rulesTickMinutes(policy),
      ),
    );
    try {
      await this.step('setup: capture.start', () => this.deps.capture.start());
    } catch (error) {
      this.deps.log?.('capture start failed', error);
      return internalFail('capture_failed');
    }
    return { ok: true };
  }

  private async mediaChanged(stored: StoredSession, on: boolean): Promise<InternalResponse> {
    const { session } = stored;
    if (on && !captureAllowed(session.status)) {
      // Defence in depth: media must never run outside an active session.
      await this.deps.capture.stop();
      return internalFail('wrong_state');
    }
    const next = transition(session, { type: 'media_changed', on });
    if (next === session) return { ok: true };
    const sendReady = on && stored.readySent !== true;
    await this.deps.store.set({
      ...stored,
      session: next,
      ...(sendReady ? { readySent: true } : {}),
    });
    await this.deps.indicator.show(on, session.examTabId);
    if (sendReady) await this.deps.notifyPage(session.examTabId, 'ready', session.sessionId);
    return { ok: true };
  }

  private async end(stored: StoredSession): Promise<void> {
    const { session } = stored;
    const step = (name: string, work: () => Promise<void>) => this.step(`end: ${name}`, work);
    // Persist "ended" first: from here on no media or rule event is accepted, even if a
    // teardown call below is slow.
    const next = await this.save(stored, { type: 'end', ts: this.deps.now() });
    // Media off before the indicator goes off: the indicator never under-reports.
    await step('capture.stop', () => this.deps.capture.stop());
    if (session.status === 'active') {
      await step('monitor.stop', () => this.deps.monitor.stop(session.examTabId));
    }
    await step('indicator.off', () => this.deps.indicator.show(false, session.examTabId));
    const { uiTabId } = next;
    if (uiTabId !== undefined) await step('ui.close', () => this.deps.tabs.close(uiTabId));
    await step('notify', () => this.deps.notifyPage(session.examTabId, 'ended', session.sessionId));
    const ts = next.session.endedAt ?? this.deps.now();
    this.background('end upload', () =>
      this.deps.api.postEnd(session.apiBase, session.sessionToken, session.sessionId, { ts }),
    );
  }
}
