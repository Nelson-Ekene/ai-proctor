import type { Category, Severity, ViolationType } from './catalogue';
import type { RiskBand } from './schemas';

// Reviewer-facing wording, shared by the dashboard and the PDF export so both say the same
// thing. Neutral by design: these are moments flagged for review, never findings or verdicts.

export const VIOLATION_LABELS: Readonly<Record<ViolationType, string>> = Object.freeze({
  fullscreen_exit: 'Left fullscreen',
  tab_switch_or_blur: 'Switched tab or window',
  copy_paste: 'Copy or paste',
  refresh_attempt: 'Page refresh',
  inactivity: 'No activity',
  no_face: 'No face in view',
  multiple_faces: 'More than one person in view',
  phone_detected: 'Phone in view',
  book_or_notes: 'Book in view',
  gaze_away_sustained: 'Looking away for a while',
  speech_detected: 'Speech',
  multiple_voices: 'More than one voice (low confidence)',
});

export const BAND_LABELS: Readonly<Record<RiskBand, string>> = Object.freeze({
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
});

export const CATEGORY_LABELS: Readonly<Record<Category, string>> = Object.freeze({
  browser: 'Browser',
  video: 'Video',
  audio: 'Audio',
});

export const SEVERITY_LABELS: Readonly<Record<Severity, string>> = Object.freeze({
  low: 'Low',
  medium: 'Medium',
  high: 'High',
});

/** The only status wording reviewers see for a flagged moment. */
export const FLAGGED_FOR_REVIEW = 'Flagged for review';
