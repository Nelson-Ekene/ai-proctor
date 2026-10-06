// Content script on exam origins only. Phase 2: recording indicator + SDK event relay.
// Never reads page content.
import type { ContentMessage, InternalResponse } from '../messages';
import { RecordingIndicator } from './overlay';

const indicator = new RecordingIndicator(document);

chrome.runtime.onMessage.addListener((message: ContentMessage, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'indicator') {
    if (message.on) indicator.show();
    else indicator.hide();
  } else {
    // Same-origin only; the SDK additionally checks event.source === window.
    window.postMessage(message.message, window.location.origin);
  }
});

// Restore the indicator after a reload or navigation within the exam origin.
chrome.runtime
  .sendMessage({ type: 'indicator:get' })
  .then((response: InternalResponse) => {
    if (response.ok && response.on === true) indicator.show();
  })
  .catch(() => undefined);
