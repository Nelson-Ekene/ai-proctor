import { CATEGORIES, type Category, type ViolationType } from './catalogue';
import { BAND_LABELS, CATEGORY_LABELS, SEVERITY_LABELS, VIOLATION_LABELS } from './labels';
import type { Policy } from './policy';
import { EVIDENCE_KINDS, type CategoryResult, type EvidenceRef, type RiskBand } from './schemas';

// Plain-language explanations for the session report, shared by the PDF/JSON export and the
// dashboard. They describe what a detector observed and how points were derived, and point the
// reviewer at what to check. Neutral by design: never a finding, verdict or intent.

export interface ViolationGuide {
  /** What the system observed and how. */
  meaning: string;
  /** What the reviewer should look at, including common ordinary causes. */
  check: string;
}

/** Per-type guidance. Numbers come from the policy so the text always matches the scoring. */
export function violationGuide(type: ViolationType, policy: Policy): ViolationGuide {
  switch (type) {
    case 'fullscreen_exit':
      return {
        meaning: 'The exam page left fullscreen mode (for example via Esc or a system pop-up).',
        check:
          'Look at the browser events around the moment: how soon fullscreen was entered again, and whether a tab or window switch followed.',
      };
    case 'tab_switch_or_blur':
      return {
        meaning:
          'The exam tab was hidden or the browser window lost focus, for example by switching tab or app.',
        check:
          'Check in the browser events how long the exam tab was away. Notifications and system dialogs can also take focus briefly.',
      };
    case 'copy_paste':
      return {
        meaning:
          'A copy, cut or paste happened on the exam page. The copied content itself is never recorded.',
        check:
          'Consider whether the exam allows copying (for example within an answer box) and whether it happened next to a tab switch.',
      };
    case 'refresh_attempt':
      return {
        meaning:
          'The exam page was reloaded or a refresh shortcut was pressed. The session continued after the reload.',
        check:
          'Repeated reloads often point to a connection or page problem; check whether the candidate reported technical issues.',
      };
    case 'inactivity':
      return {
        meaning: `No mouse, keyboard or touch activity on the exam page for ${String(policy.inactivity.seconds)} s or more.`,
        check:
          'Reading or thinking without touching the mouse is common; look at what else was flagged around the same time.',
      };
    case 'no_face':
      return {
        meaning: 'A sampled webcam frame showed no clearly detectable face.',
        check:
          'Look at the frames: the candidate may have stepped away, or the face may be hidden by dim light, the camera angle or an object.',
      };
    case 'multiple_faces':
      return {
        meaning: 'A sampled webcam frame showed more than one face or person.',
        check:
          'Check the frames for a second person. A photo, poster or screen showing a face can also be counted.',
      };
    case 'phone_detected':
      return {
        meaning: 'The on-device object model saw something it classified as a mobile phone.',
        check:
          'Check the frames: remote controls, calculators and other dark rectangular objects are sometimes taken for phones.',
      };
    case 'book_or_notes':
      return {
        meaning: 'The on-device object model saw something it classified as a book.',
        check:
          'Check the frames and whether reference material is allowed in this exam. Bookshelves in the background can also be counted.',
      };
    case 'gaze_away_sustained':
      return {
        meaning: `The head was turned away from the screen in consecutive webcam samples for ${String(policy.gazeAway.sustainedSeconds)} s or more. This is estimated from head direction, not eye movement.`,
        check:
          'Looking down at the keyboard or at scrap paper allowed by the exam also produces this; check the frames.',
      };
    case 'face_mismatch':
      return {
        meaning: `In ${String(policy.faceMatch.consecutiveSamples)} sampled webcam frames in a row, the face did not match the reference face taken on the candidate's device at the start of the session. This is an automated comparison with known error rates, not an identity check.`,
        check:
          'Compare the reference frame with the flagged frames yourself. Very bright light or a noisy camera image, other lighting changes, glasses, a hand near the face or a strong head turn can also cause this.',
      };
    case 'speech_detected':
      return {
        meaning:
          'On-device voice detection heard speech, and a short audio clip was kept (no full recording).',
        check:
          'Listen to the clip: reading questions aloud, a TV or other people nearby can also cause this.',
      };
    case 'multiple_voices':
      return {
        meaning:
          'A low-confidence estimate suggested that more than one voice was speaking in the clip.',
        check:
          'Listen to the clip before relying on this; the estimate often cannot tell similar voices apart.',
      };
  }
}

const EVIDENCE_NOUNS: Readonly<Record<EvidenceRef['kind'], readonly [string, string]>> = {
  frame: ['webcam frame', 'webcam frames'],
  audio: ['audio clip', 'audio clips'],
  event_sequence: ['browser event log', 'browser event logs'],
};

/** "2 webcam frames, 1 browser event log" (stable order). */
export function describeEvidence(refs: readonly Pick<EvidenceRef, 'kind'>[]): string {
  const parts = EVIDENCE_KINDS.flatMap((kind) => {
    const n = refs.filter((r) => r.kind === kind).length;
    if (n === 0) return [];
    const [one, many] = EVIDENCE_NOUNS[kind];
    return [`${String(n)} ${n === 1 ? one : many}`];
  });
  return parts.length > 0 ? parts.join(', ') : 'no evidence';
}

/** Time since the session started, e.g. "+07:05" or "+1:02:30". */
export function formatOffset(ms: number, startMs: number): string {
  const total = Math.max(0, Math.round((ms - startMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `+${String(h)}:${pad(m)}:${pad(s)}` : `+${pad(m)}:${pad(s)}`;
}

/** At most two decimals, no trailing zeros ("15", "13.5", "9.99"). */
function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function percent(confidence: number): string {
  return `${String(Math.round(confidence * 100))}%`;
}

export interface ExplainableViolation {
  id: string;
  type: ViolationType;
  category: Category;
  confidence: number;
  count: number;
  firstTs: number;
  lastTs: number;
  points: number;
  evidence: readonly Pick<EvidenceRef, 'kind'>[];
}

/**
 * How one flagged moment's points were derived, in words. Severity is read from the policy, as
 * in computeRisk.
 */
export function explainPoints(v: ExplainableViolation, policy: Policy): string {
  const severity = policy.severityByType[v.type];
  const base = policy.severityPoints[severity];
  const multiplies = policy.merge.countMultipliesPoints && v.count > 1;
  const formula = `${String(base)} × ${v.confidence.toFixed(2)}${multiplies ? ` × ${String(v.count)}` : ''} = ${num(v.points)} points`;
  const why = `${SEVERITY_LABELS[severity]} severity is worth ${String(base)} points, multiplied by the detector's confidence (${percent(v.confidence)})`;
  return multiplies
    ? `${formula}: ${why} and by the ${String(v.count)} merged occurrences.`
    : `${formula}: ${why}.`;
}

/** How often and over what span a merged moment happened. */
export function explainOccurrences(v: ExplainableViolation, policy: Policy): string {
  if (v.count === 1) return 'Happened once.';
  const span = Math.round((v.lastTs - v.firstTs) / 1000);
  const counted = policy.merge.countMultipliesPoints
    ? 'each occurrence adds points'
    : 'they are counted once';
  return `Happened ${String(v.count)} times over ${String(span)} s. Repeats within ${String(policy.merge.windowSeconds)} s are merged into one flagged moment and ${counted}.`;
}

export interface ExplainedViolation {
  id: string;
  /** Time since the session started. */
  offset: string;
  label: string;
  meaning: string;
  occurrences: string;
  points: string;
  evidence: string;
  check: string;
}

export function explainViolation(
  v: ExplainableViolation,
  policy: Policy,
  startMs: number,
): ExplainedViolation {
  const guide = violationGuide(v.type, policy);
  return {
    id: v.id,
    offset: formatOffset(v.firstTs, startMs),
    label: VIOLATION_LABELS[v.type],
    meaning: guide.meaning,
    occurrences: explainOccurrences(v, policy),
    points: explainPoints(v, policy),
    evidence: describeEvidence(v.evidence),
    check: guide.check,
  };
}

/** One line per category: what was flagged, the cap, the weight and the contribution. */
export function explainCategory(
  c: CategoryResult,
  violations: readonly ExplainableViolation[],
): string {
  const label = CATEGORY_LABELS[c.category];
  const weight = `${num(c.weight * 100)}%`;
  const n = violations.filter((v) => v.category === c.category).length;
  if (n === 0) {
    return `${label}: nothing flagged, so it adds 0 points (weight ${weight}).`;
  }
  const moments = `${String(n)} flagged ${n === 1 ? 'moment adds' : 'moments add'} up to ${num(c.rawPoints)} points`;
  const cap = c.capped ? `, capped at ${num(c.score)}` : '';
  return `${label}: ${moments}${cap}. At a weight of ${weight} it contributes ${c.score.toFixed(1)} × ${num(c.weight)} = ${c.contribution.toFixed(1)} points.`;
}

/** The band's range under this policy, e.g. "30 to 59". */
export function bandRange(band: RiskBand, policy: Policy): string {
  const { lowMax, mediumMax } = policy.bands;
  if (band === 'low') return `0 to ${String(lowMax)}`;
  if (band === 'medium') return `above ${String(lowMax)} up to ${String(mediumMax)}`;
  return `above ${String(mediumMax)}`;
}

/** The scoring method in plain words, with this policy's numbers. */
export function explainScoring(policy: Policy): string[] {
  const { low, medium, high } = policy.severityPoints;
  const weights = CATEGORIES.map(
    (c) => `${CATEGORY_LABELS[c].toLowerCase()} × ${num(policy.weights[c])}`,
  ).join(' + ');
  return [
    `Each flagged moment gets points: its severity (low ${String(low)}, medium ${String(medium)}, high ${String(high)}) multiplied by the detector's confidence from 0 to 1. Browser events are certain, so their confidence is 1.`,
    policy.merge.countMultipliesPoints
      ? `Repeats of the same kind within ${String(policy.merge.windowSeconds)} s are merged into one flagged moment, and each repeat adds points.`
      : `Repeats of the same kind within ${String(policy.merge.windowSeconds)} s are merged into one flagged moment and counted once.`,
    'Points are added up for each category (browser, video, audio), and each category is capped at 100.',
    `Risk score = ${weights}. Bands: Low ${bandRange('low', policy)}, Medium ${bandRange('medium', policy)}, High ${bandRange('high', policy)}.`,
  ];
}

export interface SummaryInput {
  risk: number;
  band: RiskBand;
  categories: readonly CategoryResult[];
  violations: readonly ExplainableViolation[];
  policy: Policy;
  startMs: number;
}

/** Number of highest-scoring moments named in the summary. */
const TOP_MOMENTS = 3;

/** A short plain-language summary of the report. */
export function summariseReport(input: SummaryInput): string[] {
  const { risk, band, categories, violations, policy, startMs } = input;
  const lines = [
    `This session scored ${risk.toFixed(1)} out of 100, in the ${BAND_LABELS[band]} band (${bandRange(band, policy)}). The score reflects how much was flagged and how strongly, not what happened: a person should review the flagged moments and their evidence before drawing any conclusion.`,
  ];
  if (violations.length === 0) {
    lines.push('Nothing was flagged in this session.');
    return lines;
  }

  const contributing = categories
    .filter((c) => c.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution);
  lines.push(
    `${String(violations.length)} ${violations.length === 1 ? 'moment was' : 'moments were'} flagged. The score comes from ${contributing
      .map(
        (c) => `${CATEGORY_LABELS[c.category].toLowerCase()} (${c.contribution.toFixed(1)} points)`,
      )
      .join(', ')}.`,
  );

  const top = [...violations]
    .sort((a, b) => b.points - a.points || a.firstTs - b.firstTs)
    .slice(0, TOP_MOMENTS)
    .map(
      (v) =>
        `${VIOLATION_LABELS[v.type]} at ${formatOffset(v.firstTs, startMs)} (${num(v.points)} points)`,
    );
  lines.push(`Highest-scoring moments: ${top.join('; ')}.`);

  const capped = categories.filter((c) => c.capped);
  if (capped.length > 0) {
    lines.push(
      `${capped.map((c) => CATEGORY_LABELS[c.category]).join(' and ')} reached the cap of 100, so further flags in ${capped.length === 1 ? 'that category' : 'those categories'} would not raise the score.`,
    );
  }
  return lines;
}

export interface ReportExplanation {
  summary: string[];
  scoring: string[];
  categories: string[];
  violations: ExplainedViolation[];
}

export function explainReport(input: SummaryInput): ReportExplanation {
  return {
    summary: summariseReport(input),
    scoring: explainScoring(input.policy),
    categories: input.categories.map((c) => explainCategory(c, input.violations)),
    violations: input.violations.map((v) => explainViolation(v, input.policy, input.startMs)),
  };
}
