import { EvidenceRefSchema, PROCTOR_EVENT_SOURCE, PendingAnomalySchema } from '@proctor/core';
import { z } from 'zod';
import type { ExtensionConfig } from '../config';
import type { ContentMessage } from '../messages';
import {
  deleteMedia,
  deleteQueueItems,
  getMedia,
  listMedia,
  listQueue,
  openEvidenceDb,
  putQueueItems,
} from '../shared/evidence-store';
import { createApiClient } from './api-client';
import type { OrchestratorDeps, StoredSession } from './orchestrator';
import { Uploader } from './uploader';

const STORE_KEY = 'proctor.session';
export const RULES_TICK_ALARM = 'proctor-rules-tick';
export const UPLOAD_ALARM = 'proctor-upload';
const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
/** chrome.alarms minimum delay; shorter retries also use a timer while the worker is alive. */
const ALARM_MIN_MS = 30_000;
/** Bounded waits for the offscreen document (shutdown and burst must never hang the worker). */
const OFFSCREEN_FLUSH_TIMEOUT_MS = 5_000;
const OFFSCREEN_BURST_TIMEOUT_MS = 15_000;
const OFFSCREEN_CLOSE_WAIT_MS = 3_000;

const log = (message: string, error?: unknown) => {
  console.warn(`[proctor] ${message}`, error ?? '');
};
const trace = (message: string) => {
  // Debug level: hidden by default in DevTools, captured by the e2e diagnostics log.
  console.debug(`[proctor] ${message}`);
};

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => {
        resolve(fallback);
      }, ms);
    }),
  ]);
}

const BurstReply = z.object({ ok: z.literal(true), evidence: z.array(EvidenceRefSchema) });
const FlushReply = z.object({ ok: z.literal(true), anomalies: z.array(PendingAnomalySchema) });

/** Persistent upload queue + uploader over the shared IndexedDB evidence store. */
export function createUploader(): Uploader {
  let db: Promise<IDBDatabase> | undefined;
  const getDb = () => (db ??= openEvidenceDb());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const uploader: Uploader = new Uploader({
    queue: {
      list: async () => listQueue(await getDb()),
      put: async (items) => putQueueItems(await getDb(), items),
      remove: async (ids) => deleteQueueItems(await getDb(), ids),
    },
    media: {
      get: async (ref) => getMedia(await getDb(), ref),
      remove: async (ref) => deleteMedia(await getDb(), ref),
      list: async () => listMedia(await getDb()),
    },
    async activeSessionId() {
      const data = await chrome.storage.session.get(STORE_KEY);
      const stored = data[STORE_KEY] as StoredSession | undefined;
      return stored && !['ended', 'consent_declined'].includes(stored.session.status)
        ? stored.session.sessionId
        : undefined;
    },
    fetch: (...args) => fetch(...args),
    now: () => Date.now(),
    rng: () => (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 2 ** 32,
    schedule(at) {
      const delay = Math.max(0, at - Date.now());
      // The alarm survives worker shutdown and browser restarts; the timer covers short delays.
      void chrome.alarms.create(UPLOAD_ALARM, { when: Date.now() + Math.max(delay, ALARM_MIN_MS) });
      if (delay < ALARM_MIN_MS) {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => void uploader.drain(), delay);
      }
    },
    log,
    trace,
  });
  return uploader;
}

async function sendToTab(tabId: number, message: ContentMessage): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    // Tab closed or content script not loaded yet; it asks for state when it loads.
    log('tab message not delivered', error);
  }
}

async function offscreenExists(url: string): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  });
  return contexts.length > 0;
}

export function createChromeDeps(config: ExtensionConfig, uploader: Uploader): OrchestratorDeps {
  return {
    config,
    api: createApiClient(),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    log,
    trace,

    uploads: {
      enqueue: (items) => uploader.enqueue(items),
      kick: () => void uploader.drain(),
    },

    offscreen: {
      async burst() {
        if (!(await offscreenExists(chrome.runtime.getURL(OFFSCREEN_PATH)))) return [];
        const reply: unknown = await withTimeout<unknown>(
          chrome.runtime.sendMessage({ type: 'offscreen:burst' }).catch(() => undefined),
          OFFSCREEN_BURST_TIMEOUT_MS,
          undefined,
        );
        const parsed = BurstReply.safeParse(reply);
        return parsed.success ? parsed.data.evidence : [];
      },
      async flush() {
        if (!(await offscreenExists(chrome.runtime.getURL(OFFSCREEN_PATH)))) return [];
        const reply: unknown = await withTimeout<unknown>(
          chrome.runtime.sendMessage({ type: 'offscreen:stop' }).catch(() => undefined),
          OFFSCREEN_FLUSH_TIMEOUT_MS,
          undefined,
        );
        const parsed = FlushReply.safeParse(reply);
        return parsed.success ? parsed.data.anomalies : [];
      },
    },

    store: {
      // storage.session is memory-backed and only readable by trusted extension contexts.
      async get() {
        const data = await chrome.storage.session.get(STORE_KEY);
        return data[STORE_KEY] as StoredSession | undefined;
      },
      async set(value) {
        await chrome.storage.session.set({ [STORE_KEY]: value });
      },
    },

    tabs: {
      async openConsent() {
        const tab = await chrome.tabs.create({
          url: chrome.runtime.getURL('src/pages/consent.html'),
        });
        return tab.id;
      },
      async showSetup(tabId) {
        await chrome.tabs.update(tabId, { url: chrome.runtime.getURL('src/pages/setup.html') });
      },
      async close(tabId) {
        await chrome.tabs.remove(tabId).catch(() => undefined);
      },
      async focus(tabId) {
        try {
          const tab = await chrome.tabs.update(tabId, { active: true });
          if (tab?.windowId !== undefined)
            await chrome.windows.update(tab.windowId, { focused: true });
        } catch (error) {
          log('could not focus exam tab', error);
        }
      },
      async windowOf(tabId) {
        try {
          return (await chrome.tabs.get(tabId)).windowId;
        } catch {
          return undefined;
        }
      },
    },

    monitor: {
      async start(examTabId, pingMs, tickMinutes) {
        await chrome.alarms.create(RULES_TICK_ALARM, { periodInMinutes: tickMinutes });
        await sendToTab(examTabId, { type: 'monitor', pingMs });
      },
      async stop(examTabId) {
        await chrome.alarms.clear(RULES_TICK_ALARM);
        await sendToTab(examTabId, { type: 'monitor', pingMs: null });
      },
    },

    capture: {
      async start() {
        const url = chrome.runtime.getURL(OFFSCREEN_PATH);
        if (await offscreenExists(url)) return;
        await chrome.offscreen.createDocument({
          url,
          reasons: [chrome.offscreen.Reason.USER_MEDIA],
          justification:
            'Samples camera and microphone during an exam session the candidate consented to.',
        });
      },
      async stop() {
        // Closing the document ends every media track it holds. Chrome can take tens of seconds
        // to close it on a loaded machine; the session must not wait for that (media tracks are
        // already stopped by the offscreen document itself on "offscreen:stop"), so the wait is
        // bounded and a slow close finishes in the background.
        const started = Date.now();
        if (!(await offscreenExists(chrome.runtime.getURL(OFFSCREEN_PATH)))) return;
        trace(`capture.stop: contexts checked in ${String(Date.now() - started)}ms`);
        const closing = chrome.offscreen
          .closeDocument()
          .then(() => {
            trace(`capture.stop: document closed after ${String(Date.now() - started)}ms`);
          })
          .catch((error: unknown) => {
            log('closing the offscreen document failed', error);
          });
        const finished = await withTimeout(
          closing.then(() => true),
          OFFSCREEN_CLOSE_WAIT_MS,
          false,
        );
        if (!finished) log('offscreen document still closing; continuing without waiting');
      },
    },

    indicator: {
      async show(on, examTabId) {
        await chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' });
        await chrome.action.setBadgeText({ text: on ? 'ON' : '' });
        await chrome.action.setTitle({
          title: on ? 'Proctoring: camera and microphone on' : 'Proctoring: inactive',
        });
        await sendToTab(examTabId, { type: 'indicator', on });
      },
    },

    async notifyPage(tabId, event, sessionId) {
      await sendToTab(tabId, {
        type: 'sdk-event',
        message: { source: PROCTOR_EVENT_SOURCE, event, sessionId },
      });
    },
  };
}
