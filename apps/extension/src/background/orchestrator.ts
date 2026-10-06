import {
  ExternalRequestSchema,
  captureAllowed,
  isTerminal,
  transition,
  type ConsentRecord,
  type ExternalErrorCode,
  type ExternalResponse,
  type SdkEventName,
  type SessionEvent,
  type SessionState,
} from '@proctor/core';
import { isAllowedOrigin, type ExtensionConfig } from '../config';
import {
  InternalRequestSchema,
  NOTICE_VERSION,
  type InternalError,
  type InternalResponse,
} from '../messages';
import type { ApiClient } from './api-client';

/** Everything the service worker persists. Lives in chrome.storage.session (memory only). */
export interface StoredSession {
  session: SessionState;
  /** Tab showing the consent/setup pages, if open. */
  uiTabId?: number;
  readySent?: boolean;
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
  };
  /** Offscreen document that owns the camera/microphone stream. */
  capture: { start(): Promise<void>; stop(): Promise<void> };
  /** Badge + in-page overlay. */
  indicator: { show(on: boolean, examTabId: number): Promise<void> };
  /** Relays an SDK event to the exam tab's content script. Must not throw. */
  notifyPage(tabId: number, event: SdkEventName, sessionId: string): Promise<void>;
  now(): number;
  log?(message: string, error?: unknown): void;
}

export interface ExternalSender {
  url: string | undefined;
  tabId: number | undefined;
}

export interface InternalSender {
  kind: 'extension_page' | 'content_script' | 'unknown';
  tabId: number | undefined;
}

const fail = (error: ExternalErrorCode): ExternalResponse => ({ ok: false, error });
const internalFail = (error: InternalError): InternalResponse => ({ ok: false, error });

/**
 * Service-worker orchestrator. Stateless between calls (state is in the store) so it survives
 * MV3 worker restarts. Calls are serialised so interleaved Chrome events cannot race.
 */
export class Orchestrator {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: OrchestratorDeps) {}

  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  handleExternal(raw: unknown, sender: ExternalSender): Promise<ExternalResponse> {
    return this.run(async () => {
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
    return this.run(async () => {
      const parsed = InternalRequestSchema.safeParse(raw);
      if (!parsed.success) return internalFail('invalid_request');
      const request = parsed.data;
      const stored = await this.deps.store.get();

      if (request.type === 'indicator:get') {
        if (sender.kind !== 'content_script') return internalFail('not_allowed');
        const on = stored?.session.mediaOn === true && stored.session.examTabId === sender.tabId;
        return { ok: true, on };
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
      }
    });
  }

  handleTabRemoved(tabId: number): Promise<void> {
    return this.run(async () => {
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
    // Declining always succeeds locally; recording it is best effort.
    try {
      await this.deps.api.postConsent(
        session.apiBase,
        session.sessionToken,
        session.sessionId,
        this.consentRecord('declined', noticeVersion),
      );
    } catch (error) {
      this.deps.log?.('decline upload failed', error);
    }
    const next = await this.save(stored, { type: 'consent_declined', ts: this.deps.now() });
    if (next.uiTabId !== undefined) await this.deps.tabs.close(next.uiTabId);
    await this.deps.tabs.focus(session.examTabId);
    await this.deps.notifyPage(session.examTabId, 'consent_declined', session.sessionId);
    return { ok: true } as const;
  }

  private async completeSetup(stored: StoredSession): Promise<InternalResponse> {
    if (stored.session.status !== 'setup') return internalFail('wrong_state');
    const next = await this.save(stored, { type: 'setup_completed', ts: this.deps.now() });
    if (next.uiTabId !== undefined) {
      const { uiTabId, ...rest } = next;
      await this.deps.store.set(rest);
      await this.deps.tabs.close(uiTabId);
    }
    await this.deps.tabs.focus(next.session.examTabId);
    try {
      await this.deps.capture.start();
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
    await this.deps.capture.stop();
    const next = await this.save(stored, { type: 'end', ts: this.deps.now() });
    await this.deps.indicator.show(false, session.examTabId);
    if (next.uiTabId !== undefined) await this.deps.tabs.close(next.uiTabId);
    try {
      await this.deps.api.postEnd(session.apiBase, session.sessionToken, session.sessionId, {
        ts: next.session.endedAt ?? this.deps.now(),
      });
    } catch (error) {
      this.deps.log?.('end upload failed', error);
    }
    await this.deps.notifyPage(session.examTabId, 'ended', session.sessionId);
  }
}
