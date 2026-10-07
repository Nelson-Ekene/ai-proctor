// MV3 service worker. Never touches camera or microphone (that is the offscreen document's job).
// Listeners are registered synchronously at top level so Chrome can wake the worker for them.
import { RULES_TICK_ALARM, createChromeDeps } from './chrome-deps';
import { Orchestrator } from './orchestrator';
import { classifySender } from './sender';

const config = __PROCTOR_CONFIG__;
const orchestrator = new Orchestrator(createChromeDeps(config));

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  void orchestrator
    .handleExternal(message, { url: sender.url, tabId: sender.tab?.id })
    .then(sendResponse);
  return true; // async response
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void orchestrator
    .handleInternal(message, classifySender(sender, chrome.runtime.id, config))
    .then(sendResponse);
  return true;
});

// Fires on close only; a page refresh keeps the tab and therefore the session.
chrome.tabs.onRemoved.addListener((tabId) => {
  void orchestrator.handleTabRemoved(tabId);
});

// Browser rule signals observed from the service worker (Phase 3).
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void orchestrator.handleTabActivated(tabId, windowId);
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  void orchestrator.handleWindowFocus(windowId);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RULES_TICK_ALARM) void orchestrator.handleRulesTick();
});
