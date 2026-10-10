import type { BrowserLogEntry, EvidenceRef } from '@proctor/core';

// Dashboard-only wording. Shared reviewer labels (violation types, bands, categories,
// severities) come from @proctor/core so the PDF export says the same thing.

export const EVENT_LABELS: Readonly<Record<BrowserLogEntry['type'], string>> = {
  fullscreen_enter: 'Entered fullscreen',
  fullscreen_exit: 'Left fullscreen',
  visibility_hidden: 'Exam tab hidden',
  visibility_visible: 'Exam tab visible again',
  window_blur: 'Browser window lost focus',
  window_focus: 'Browser window focused again',
  copy: 'Copy',
  cut: 'Cut',
  paste: 'Paste',
  refresh_attempt: 'Page refresh',
  inactivity: 'No activity began',
  activity_resumed: 'Activity resumed',
};

export const EVIDENCE_KIND_LABELS: Readonly<Record<EvidenceRef['kind'], string>> = {
  frame: 'Webcam frame',
  audio: 'Audio clip',
  event_sequence: 'Browser events',
};

export const STATUS_LABELS = { created: 'Not started', active: 'In progress', ended: 'Ended' };
