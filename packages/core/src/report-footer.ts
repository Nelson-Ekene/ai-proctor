// Text for the risk report footer (Phase 8 renders it; PDF/JSON exports include it).
// Documented limitations tell reviewers what the system cannot see, so absence of a flag is
// never read as proof. Keep entries short, plain-language and free of verdict words.

export const REPORT_LIMITATIONS: readonly string[] = Object.freeze([
  'This report is advisory. It flags moments for human review and never decides a result.',
  'A second device or screen is out of scope in v1 and is not detected.',
  'If the exam tab is dragged into another browser window, window focus changes in that new window are not detected; switching away from the tab is still detected.',
  'Webcam frames are sampled at random moments, so short events between samples can be missed.',
  'Gaze is estimated from head direction, not eye movement; a face seen fully in profile has no measurable direction.',
  'Books are detected by an on-device object model; loose paper notes are not reliably detected.',
  'Phone and book detection is less reliable in very dim or overexposed light, with low-quality or blurry cameras and during movement; absence of these flags is not proof.',
  'Optional face matching compares faces with a reference taken on the device at the start. Very bright light, heavy camera noise, glasses or a partly covered face can make the same person look different to it, so a face-mismatch flag must be checked against the reference frame. If no reference could be taken, nothing is compared, so absence of this flag is not proof of anything.',
  'Speech is detected on the device and only a short clip is kept; whispering or very quiet speech can be missed.',
  'Multiple voices are estimated with a low-confidence heuristic that mainly separates clearly different voice pitches; two similar voices are usually not distinguished.',
]);
