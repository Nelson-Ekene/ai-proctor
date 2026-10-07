// Content script on exam origins only: recording indicator, SDK event relay, and the browser
// signal sensor for the rule engine (which runs in the service worker). Never reads page content.
import type { RawBrowserEvent } from '@proctor/core';
import type { ContentMessage, InternalRequest, InternalResponse } from '../messages';
import { BrowserMonitor } from './monitor';
import { RecordingIndicator } from './overlay';

const indicator = new RecordingIndicator(document);

const send = (request: InternalRequest) =>
  chrome.runtime.sendMessage<InternalRequest, InternalResponse>(request);

const monitor = new BrowserMonitor({
  doc: document,
  win: window,
  now: () => Date.now(),
  send: (event: RawBrowserEvent) => {
    send({ type: 'rules:event', event }).catch(() => undefined);
  },
  navigationType: () =>
    (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)
      ?.type,
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (id) => {
    window.clearInterval(id as number);
  },
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
});

chrome.runtime.onMessage.addListener((message: ContentMessage, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  switch (message.type) {
    case 'indicator':
      if (message.on) indicator.show();
      else indicator.hide();
      break;
    case 'monitor':
      if (message.pingMs === null) monitor.stop();
      else monitor.start({ pingMs: message.pingMs, pageLoad: false });
      break;
    case 'sdk-event':
      // Same-origin only; the SDK additionally checks event.source === window.
      window.postMessage(message.message, window.location.origin);
      break;
  }
});

// On load (including after a refresh): restore the indicator and resume monitoring.
send({ type: 'content:get' })
  .then((response) => {
    if (!response.ok) return;
    if (response.on === true) indicator.show();
    if (response.monitorPingMs !== undefined) {
      monitor.start({ pingMs: response.monitorPingMs, pageLoad: true });
    }
  })
  .catch(() => undefined);
