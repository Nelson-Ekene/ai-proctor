import { PROCTOR_EVENT_SOURCE } from '@proctor/core';
import type { ExtensionConfig } from '../config';
import type { ContentMessage } from '../messages';
import { createApiClient } from './api-client';
import type { OrchestratorDeps, StoredSession } from './orchestrator';

const STORE_KEY = 'proctor.session';
export const RULES_TICK_ALARM = 'proctor-rules-tick';
const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

const log = (message: string, error?: unknown) => {
  console.warn(`[proctor] ${message}`, error ?? '');
};

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

export function createChromeDeps(config: ExtensionConfig): OrchestratorDeps {
  return {
    config,
    api: createApiClient(),
    now: () => Date.now(),
    log,
    // Debug level: hidden by default in DevTools, captured by the e2e diagnostics log.
    trace: (message) => {
      console.debug(`[proctor] ${message}`);
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
        // Closing the document ends every media track it holds.
        if (await offscreenExists(chrome.runtime.getURL(OFFSCREEN_PATH))) {
          await chrome.offscreen.closeDocument();
        }
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
