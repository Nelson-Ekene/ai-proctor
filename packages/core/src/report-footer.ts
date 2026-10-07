// Text for the risk report footer (Phase 8 renders it; PDF/JSON exports include it).
// Documented limitations tell reviewers what the system cannot see, so absence of a flag is
// never read as proof. Keep entries short, plain-language and free of verdict words.

export const REPORT_LIMITATIONS: readonly string[] = Object.freeze([
  'This report is advisory. It flags moments for human review and never decides a result.',
  'A second device or screen is out of scope in v1 and is not detected.',
  'If the exam tab is dragged into another browser window, window focus changes in that new window are not detected; switching away from the tab is still detected.',
  'Webcam frames are sampled at random moments, so short events between samples can be missed.',
]);
