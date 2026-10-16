import type { Category, Severity, ViolationType } from './catalogue';
import type { FaceMatchStatus } from './face-match';
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
  face_mismatch: 'Face differs from the start of the session',
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

export const FACE_MATCH_STATUS_LABELS: Readonly<Record<FaceMatchStatus, string>> = Object.freeze({
  not_offered: 'Not used (off in the policy)',
  not_opted_in: 'Not used (the candidate did not opt in)',
  opted_in:
    'Candidate opted in. Face matching ran on the device if a reference face could be taken at the start; no face template was uploaded.',
});

/** The only status wording reviewers see for a flagged moment. */
export const FLAGGED_FOR_REVIEW = 'Flagged for review';
