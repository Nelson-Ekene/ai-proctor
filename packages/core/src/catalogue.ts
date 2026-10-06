// Violation catalogue (PRD "Violation catalogue", BUILD_PLAN 5.2).
// Structural facts only. Default severities are policy and live in DEFAULT_POLICY.

export const CATEGORIES = ['browser', 'video', 'audio'] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEVERITIES = ['low', 'medium', 'high'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const VIOLATION_TYPES = [
  'fullscreen_exit',
  'tab_switch_or_blur',
  'copy_paste',
  'refresh_attempt',
  'inactivity',
  'no_face',
  'multiple_faces',
  'phone_detected',
  'book_or_notes',
  'gaze_away_sustained',
  'speech_detected',
  'multiple_voices',
] as const;
export type ViolationType = (typeof VIOLATION_TYPES)[number];

/** Browser rules are deterministic (confidence 1.0); video/audio confidence comes from a model. */
export type ConfidenceSource = 'deterministic' | 'model';

export interface CatalogueEntry {
  readonly category: Category;
  readonly confidenceSource: ConfidenceSource;
}

export const VIOLATION_CATALOGUE: Readonly<Record<ViolationType, CatalogueEntry>> = Object.freeze({
  fullscreen_exit: { category: 'browser', confidenceSource: 'deterministic' },
  tab_switch_or_blur: { category: 'browser', confidenceSource: 'deterministic' },
  copy_paste: { category: 'browser', confidenceSource: 'deterministic' },
  refresh_attempt: { category: 'browser', confidenceSource: 'deterministic' },
  inactivity: { category: 'browser', confidenceSource: 'deterministic' },
  no_face: { category: 'video', confidenceSource: 'model' },
  multiple_faces: { category: 'video', confidenceSource: 'model' },
  phone_detected: { category: 'video', confidenceSource: 'model' },
  book_or_notes: { category: 'video', confidenceSource: 'model' },
  gaze_away_sustained: { category: 'video', confidenceSource: 'model' },
  speech_detected: { category: 'audio', confidenceSource: 'model' },
  multiple_voices: { category: 'audio', confidenceSource: 'model' },
});

export function categoryOf(type: ViolationType): Category {
  return VIOLATION_CATALOGUE[type].category;
}
