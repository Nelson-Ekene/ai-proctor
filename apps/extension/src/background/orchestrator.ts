import {
  ExternalRequestSchema,
  captureAllowed,
  categoryOf,
  createRuleEngineState,
  isTerminal,
  openAnomaly,
  packageAnomaly,
  priorityFor,
  stepRuleEngine,
  transition,
  type ConsentRecord,
  type EvidenceRef,
  type ExternalErrorCode,
  type ExternalResponse,
  type OpenAnomaly,
  type PendingAnomaly,
  type Policy,
  type QueueKind,
  type RawBrowserEvent,
  type RuleEngineState,
  type SdkEventName,
  type SessionEvent,
  type SessionState,
  type SetupCheckRecord,
} from '@proctor/core';
import { isAllowedOrigin, type ExtensionConfig } from '../config';
import type { QueueItem, QueuedRequest } from '../shared/evidence-store';
import {
  FACE_MATCH_NOTICE_VERSION,
  InternalRequestSchema,
  NOTICE_VERSION,
  type InternalError,
  type AudioMetaRecord,
  type InternalResponse,
  type SetupResult,
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
  /**
   * Anomalies detected this session. Each waits for its capture window to close, is then
   * packaged (event sequence + evidence) into the upload queue and marked `packaged`.
   */
  anomalies?: SessionAnomaly[];
  /** Webcam sampling state, e.g. reduced rate on a slow device (Phase 4). */
  videoMeta?: VideoMetaRecord;
  /** Microphone monitoring state (Phase 5). */
  audioMeta?: AudioMetaRecord;
  /** The candidate opted in to face matching on the consent notice (Phase 11). */
  faceMatchConsent?: boolean;
}

export interface SessionAnomaly extends OpenAnomaly {
  /** True once queued for upload (its "before" snapshot is then dropped). */
  packaged?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

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
  /** Persistent upload queue (Phase 6). `kick` starts a drain without waiting for it. */
  uploads: { enqueue(items: QueueItem[]): Promise<boolean>; kick(): void };
  /** Requests to the offscreen document. Both resolve empty if it is absent or unresponsive. */
  offscreen: {
    /** Captures capture.burstFrames extra frames now (for anomalies without frames). */
    burst(): Promise<EvidenceRef[]>;
    /** Stops analysis and returns anomalies of a clip that was still in progress. */
    flush(): Promise<PendingAnomaly[]>;
  };
  /** Unique ids for anomalies and evidence (also their upload idempotency keys). */
  newId(): string;
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
          // Face-matching consent can only be given when the policy offers it.
          if (
            request.noticeVersion === FACE_MATCH_NOTICE_VERSION &&
            !(request.accepted && session.policy.faceMatch.enabled)
          ) {
            return internalFail('invalid_request');
          }
          return request.accepted
            ? this.accept(stored, request.noticeVersion, sender.tabId)
            : this.decline(stored, request.noticeVersion);

        case 'setup:get':
          return session.status === 'setup'
            ? { ok: true, policy: session.policy }
            : internalFail('wrong_state');

        case 'setup:complete':
          return this.completeSetup(stored, request.result);

        case 'media:state':
          return this.mediaChanged(stored, request.on);

        case 'video:config':
          return session.status === 'active'
            ? {
                ok: true,
                policy: session.policy,
                sessionId: session.sessionId,
                faceMatch: session.policy.faceMatch.enabled && stored.faceMatchConsent === true,
              }
            : internalFail('wrong_state');

        case 'video:anomalies':
        case 'audio:anomalies': {
          if (session.status !== 'active') return internalFail('wrong_state');
          // Each channel may only report its own category (webcam / microphone findings).
          const category = request.type === 'video:anomalies' ? 'video' : 'audio';
          if (request.anomalies.some((a) => categoryOf(a.type) !== category)) {
            return internalFail('invalid_request');
          }
          await this.packageDue(await this.addAnomalies(stored, request.anomalies));
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
    // Every rule event (including the periodic ticks) also packages closed capture windows.
    await this.packageDue(await this.addAnomalies({ ...stored, rules: state }, anomalies));
  }

  /**
   * Records detected anomalies, each opening a capture window (FR6) with a snapshot of the
   * preceding browser events. Anomalies without frames (browser, audio) ask the offscreen
   * document for a burst of extra frames. Persists and returns the new state.
   */
  private async addAnomalies(
    stored: StoredSession,
    detected: readonly PendingAnomaly[],
    options: { burst: boolean } = { burst: true },
  ): Promise<StoredSession> {
    if (detected.length === 0) {
      await this.deps.store.set(stored);
      return stored;
    }
    const { policy } = stored.session;
    const log = stored.rules?.log ?? [];
    const opened: SessionAnomaly[] = detected.map((d) =>
      openAnomaly(d, this.deps.newId(), log, policy),
    );
    const next = { ...stored, anomalies: [...(stored.anomalies ?? []), ...opened] };
    await this.deps.store.set(next);
    const needFrames = opened.filter((a) => !(a.evidence ?? []).some((e) => e.kind === 'frame'));
    if (options.burst && needFrames.length > 0) this.requestBurst(needFrames.map((a) => a.id));
    return next;
  }

  /** Burst capture runs outside the queue (it takes seconds); frames are attached afterwards. */
  private requestBurst(anomalyIds: readonly string[]): void {
    this.background('burst', async () => {
      const frames = await this.deps.offscreen.burst();
      if (frames.length === 0) return;
      await this.run('attachBurst', async () => {
        const stored = await this.deps.store.get();
        if (!stored?.anomalies) return;
        const anomalies = stored.anomalies.map((a) =>
          anomalyIds.includes(a.id) && !a.packaged
            ? { ...a, evidence: [...(a.evidence ?? []), ...frames] }
            : a,
        );
        await this.deps.store.set({ ...stored, anomalies });
      });
    });
  }

  /**
   * Packages every anomaly whose capture window has closed (or all, when `force` is set at
   * session end) and hands the records + evidence to the upload queue. The queue is written
   * before the anomalies are marked packaged, so a crash can only cause a harmless re-send
   * (same idempotency keys), never a loss.
   */
  private async packageDue(stored: StoredSession, force = false): Promise<StoredSession> {
    const now = this.deps.now();
    const due = (stored.anomalies ?? []).filter((a) => !a.packaged && (force || a.closesAt <= now));
    if (due.length === 0) return stored;
    const { session } = stored;
    const log = stored.rules?.log ?? [];
    const clips = (stored.anomalies ?? []).flatMap((a) =>
      (a.evidence ?? []).filter((e) => e.kind === 'audio'),
    );
    const items: QueueItem[] = [];
    for (const open of due) {
      const pkg = packageAnomaly(open, log, clips, this.deps.newId(), session.policy);
      const severity = session.policy.severityByType[open.type];
      const group = { group: open.id, priority: priorityFor('anomaly', severity) };
      items.push(
        this.queueItem(session, 'anomaly', open.id, group, {
          method: 'POST',
          path: `/v1/sessions/${encodeURIComponent(session.sessionId)}/anomalies`,
          contentType: 'application/json',
          body: JSON.stringify(pkg.anomaly),
        }),
      );
      for (const ref of pkg.anomaly.evidence) {
        const path = `/v1/sessions/${encodeURIComponent(session.sessionId)}/evidence/${encodeURIComponent(ref.id)}`;
        const evidence = { ...group, dependsOn: open.id };
        if (ref.kind === 'event_sequence') {
          const body = JSON.stringify(pkg.eventSequence);
          items.push(
            this.queueItem(session, 'evidence', ref.id, evidence, {
              method: 'PUT',
              path,
              contentType: 'application/json',
              body,
            }),
          );
        } else {
          const store = ref.kind === 'frame' ? 'frames' : 'clips';
          items.push(
            this.queueItem(session, 'evidence', ref.id, evidence, {
              method: 'PUT',
              path,
              contentType: ref.kind === 'frame' ? 'image/jpeg' : 'audio/wav',
              media: { store, id: ref.id },
            }),
          );
        }
      }
    }
    await this.deps.uploads.enqueue(items);
    const dueIds = new Set(due.map((a) => a.id));
    const next = {
      ...stored,
      anomalies: (stored.anomalies ?? []).map((a) =>
        dueIds.has(a.id) ? { ...a, packaged: true, before: [] } : a,
      ),
    };
    await this.deps.store.set(next);
    this.deps.uploads.kick();
    this.deps.trace?.(
      `packaged ${String(due.length)} anomalies into ${String(items.length)} uploads`,
    );
    return next;
  }

  private queueItem(
    session: SessionState,
    kind: QueueKind,
    id: string,
    extra: { priority?: number; group?: string; dependsOn?: string },
    request: Omit<QueuedRequest, 'apiBase' | 'token'>,
  ): QueueItem {
    const now = this.deps.now();
    return {
      id,
      sessionId: session.sessionId,
      kind,
      priority: extra.priority ?? priorityFor(kind),
      ...(extra.group === undefined ? {} : { group: extra.group }),
      ...(extra.dependsOn === undefined ? {} : { dependsOn: extra.dependsOn }),
      bytes: request.body?.length ?? 0,
      createdAt: now,
      attempts: 0,
      nextAttemptAt: now,
      // Never keep anything on the device longer than the server would keep it.
      expiresAt: now + session.policy.retentionDays * DAY_MS,
      retry: session.policy.upload,
      request: { apiBase: session.apiBase, token: session.sessionToken, ...request },
    };
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
    const next = await this.save(
      noticeVersion === FACE_MATCH_NOTICE_VERSION ? { ...stored, faceMatchConsent: true } : stored,
      { type: 'consent_accepted', ts: this.deps.now() },
    );
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
    // The decline record goes through the persistent queue so it eventually reaches the server
    // even if it is unreachable now.
    try {
      await this.deps.uploads.enqueue([
        this.queueItem(
          session,
          'consent',
          this.deps.newId(),
          {},
          {
            method: 'POST',
            path: `/v1/sessions/${encodeURIComponent(session.sessionId)}/consents`,
            contentType: 'application/json',
            body: JSON.stringify(record),
          },
        ),
      ]);
      this.deps.uploads.kick();
    } catch (error) {
      this.deps.log?.('could not queue the decline record', error);
    }
    return { ok: true } as const;
  }

  private async completeSetup(
    stored: StoredSession,
    result: SetupResult,
  ): Promise<InternalResponse> {
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
    // The setup outcome (a device check, not an exam result) feeds the completion-rate metric.
    // Best effort through the persistent queue: it never delays the session.
    try {
      const record: SetupCheckRecord = { result, ts: this.deps.now() };
      await this.deps.uploads.enqueue([
        this.queueItem(
          activated,
          'setup',
          this.deps.newId(),
          {},
          {
            method: 'POST',
            path: `/v1/sessions/${encodeURIComponent(activated.sessionId)}/setup-check`,
            contentType: 'application/json',
            body: JSON.stringify(record),
          },
        ),
      ]);
      this.deps.uploads.kick();
    } catch (error) {
      this.deps.log?.('could not queue the setup-check record', error);
    }
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
    let next = await this.save(stored, { type: 'end', ts: this.deps.now() });
    const wasActive = session.status === 'active';
    // Collect a speech clip still being recorded before the offscreen document closes.
    const flushed = wasActive
      ? await this.step('end: offscreen.flush', () => this.deps.offscreen.flush())
      : [];
    // Media off before the indicator goes off: the indicator never under-reports.
    await step('capture.stop', () => this.deps.capture.stop());
    if (wasActive) {
      await step('monitor.stop', () => this.deps.monitor.stop(session.examTabId));
    }
    await step('indicator.off', () => this.deps.indicator.show(false, session.examTabId));
    const { uiTabId } = next;
    if (uiTabId !== undefined) await step('ui.close', () => this.deps.tabs.close(uiTabId));
    await step('notify', () => this.deps.notifyPage(session.examTabId, 'ended', session.sessionId));

    // Flush: package every remaining anomaly now (windows are cut short at session end), then
    // queue the end record last (lowest priority), and start uploading.
    try {
      next = await this.addAnomalies(next, flushed, { burst: false });
      next = await this.packageDue(next, true);
      const ts = next.session.endedAt ?? this.deps.now();
      await this.deps.uploads.enqueue([
        this.queueItem(
          next.session,
          'end',
          this.deps.newId(),
          {},
          {
            method: 'POST',
            path: `/v1/sessions/${encodeURIComponent(session.sessionId)}/end`,
            contentType: 'application/json',
            body: JSON.stringify({ ts }),
          },
        ),
      ]);
      this.deps.uploads.kick();
    } catch (error) {
      this.deps.log?.('could not queue end-of-session uploads', error);
    }
  }
}
