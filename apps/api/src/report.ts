import {
  computeRisk,
  explainReport,
  faceMatchStatus,
  BAND_LABELS,
  CATEGORY_LABELS,
  FACE_MATCH_STATUS_LABELS,
  REPORT_LIMITATIONS,
  SEVERITY_LABELS,
  VIOLATION_LABELS,
  VIOLATION_TYPES,
  type CategoryResult,
  type EvidenceRef,
  type FaceMatchStatus,
  type Policy,
  type ReportExplanation,
  type RiskBand,
  type Violation,
} from '@proctor/core';
import { and, desc, eq } from 'drizzle-orm';
import PDFDocument from 'pdfkit';
import type { Db } from './db/client';
import { consents, evidence, sessions } from './db/schema';
import { storedViolations } from './ingest';

// The session report (FR10-FR12). Advisory: it ranks moments for human review and never states
// a verdict. The score is recomputed from the stored violations + the session's policy
// snapshot on every request, and compared with the stored score as a reproducibility check.

export interface ReportEvidence extends EvidenceRef {
  uploaded: boolean;
}

export interface ReportViolation extends Omit<Violation, 'evidence'> {
  label: string;
  points: number;
  evidence: ReportEvidence[];
}

export interface SessionReport {
  session: {
    id: string;
    examId: string | null;
    candidateRef: string;
    status: string;
    startedAt: string;
    endedAt: string | null;
    policyVersionId: string | null;
  };
  risk: number;
  band: RiskBand;
  categories: CategoryResult[];
  violations: ReportViolation[];
  policySnapshot: Policy;
  /** Optional face matching (Phase 11): offered by the policy and opted in to by the candidate. */
  faceMatch: FaceMatchStatus;
  /** True when the recomputed score equals the score stored at ingest time. */
  reproducible: boolean;
  /** Plain-language summary, scoring method and per-moment guidance for reviewers. */
  explanation: ReportExplanation;
  limitations: readonly string[];
  generatedAt: string;
}

export async function buildReport(
  db: Db,
  sessionId: string,
  now: Date,
): Promise<SessionReport | undefined> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session) return undefined;

  const stored = await storedViolations(db, sessionId);
  const scored = computeRisk(stored, session.policySnapshot);
  const uploaded = new Set(
    (
      await db
        .select({ id: evidence.id, uploadedAt: evidence.uploadedAt })
        .from(evidence)
        .where(eq(evidence.sessionId, sessionId))
    )
      .filter((e) => e.uploadedAt !== null)
      .map((e) => e.id),
  );
  const [accepted] = await db
    .select({ noticeVersion: consents.noticeVersion })
    .from(consents)
    .where(and(eq(consents.sessionId, sessionId), eq(consents.decision, 'accepted')))
    .orderBy(desc(consents.ts))
    .limit(1);
  const points = new Map(scored.violations.map((v) => [v.violationId, v.points]));
  const violations = stored.map((v) => ({
    ...v,
    label: VIOLATION_LABELS[v.type],
    points: points.get(v.id) ?? 0,
    evidence: v.evidence.map((e) => ({ ...e, uploaded: uploaded.has(e.id) })),
  }));

  return {
    session: {
      id: session.id,
      examId: session.examId,
      candidateRef: session.candidateRef,
      status: session.status,
      startedAt: session.startedAt.toISOString(),
      endedAt: session.endedAt?.toISOString() ?? null,
      policyVersionId: session.policyVersionId,
    },
    risk: scored.risk,
    band: scored.band,
    categories: scored.categories,
    violations,
    policySnapshot: scored.policySnapshot,
    faceMatch: faceMatchStatus(scored.policySnapshot, accepted?.noticeVersion),
    reproducible: scored.risk === session.risk && scored.band === session.band,
    explanation: explainReport({
      risk: scored.risk,
      band: scored.band,
      categories: scored.categories,
      violations,
      policy: scored.policySnapshot,
      startMs: session.startedAt.getTime(),
    }),
    limitations: REPORT_LIMITATIONS,
    generatedAt: now.toISOString(),
  };
}

// --- PDF export -----------------------------------------------------------------------------

const MARGIN = 48;
const INK = '#111827';
const MUTED = '#4b5563';
const RULE = '#d1d5db';
const SHADE = '#f3f4f6';
const BAND_COLOURS: Readonly<Record<RiskBand, { fill: string; text: string }>> = {
  low: { fill: '#dcfce7', text: '#166534' },
  medium: { fill: '#fef3c7', text: '#92400e' },
  high: { fill: '#fee2e2', text: '#991b1b' },
};

/** "2026-10-10 19:44:03 UTC" */
function time(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC');
}

/** "19:44:03 UTC" */
function clock(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 19)} UTC`;
}

function duration(startIso: string, endIso: string | null): string {
  if (!endIso) return 'not ended';
  const minutes = Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000);
  return minutes < 60
    ? `${String(minutes)} min`
    : `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`;
}

function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

type Pdf = PDFKit.PDFDocument;

function contentWidth(doc: Pdf): number {
  return doc.page.width - MARGIN * 2;
}

/** Starts a new page when fewer than `height` points remain, so a section is never split. */
function ensureSpace(doc: Pdf, height: number): void {
  if (doc.y + height > doc.page.height - MARGIN) doc.addPage();
}

function rule(doc: Pdf, y: number): void {
  doc
    .moveTo(MARGIN, y)
    .lineTo(MARGIN + contentWidth(doc), y)
    .lineWidth(0.5)
    .strokeColor(RULE)
    .stroke();
}

/** `keepWith` is the space the first content under the heading needs on the same page. */
function heading(doc: Pdf, text: string, keepWith = 40): void {
  ensureSpace(doc, 30 + keepWith);
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(text, MARGIN);
  rule(doc, doc.y + 2);
  doc.moveDown(0.5);
}

function paragraph(doc: Pdf, text: string, size = 10, colour = INK): void {
  doc
    .font('Helvetica')
    .fontSize(size)
    .fillColor(colour)
    .text(text, MARGIN, doc.y, { width: contentWidth(doc), lineGap: 1.5 });
  doc.moveDown(0.35);
}

function bullet(doc: Pdf, text: string, size = 10, colour = INK): void {
  doc
    .font('Helvetica')
    .fontSize(size)
    .fillColor(colour)
    .text(`•  ${text}`, MARGIN + 6, doc.y, { width: contentWidth(doc) - 6, lineGap: 1.5 });
  doc.moveDown(0.2);
}

/** A bold label followed by text that wraps under it. */
function labelled(doc: Pdf, label: string, text: string): void {
  doc
    .font('Helvetica-Bold')
    .fontSize(9.5)
    .fillColor(INK)
    .text(`${label}  `, MARGIN, doc.y, {
      width: contentWidth(doc),
      continued: true,
      lineGap: 1.5,
    })
    .font('Helvetica')
    .text(text);
  doc.moveDown(0.15);
}

function details(doc: Pdf, report: SessionReport): void {
  const { session } = report;
  const rows: [string, string][] = [
    ['Candidate reference', session.candidateRef],
    ['Session', session.id],
    ...(session.examId ? [['Exam', session.examId] as [string, string]] : []),
    ['Started', time(Date.parse(session.startedAt))],
    ['Ended', session.endedAt ? time(Date.parse(session.endedAt)) : 'not ended'],
    ['Duration', duration(session.startedAt, session.endedAt)],
  ];
  doc.font('Helvetica').fontSize(10);
  for (const [label, value] of rows) {
    const y = doc.y;
    doc.fillColor(MUTED).text(label, MARGIN, y, { width: 130 });
    doc.fillColor(INK).text(value, MARGIN + 130, y, { width: contentWidth(doc) - 130 });
    doc.moveDown(0.2);
  }
}

function scoreBox(doc: Pdf, report: SessionReport): void {
  const colours = BAND_COLOURS[report.band];
  const width = contentWidth(doc);
  const top = doc.y + 8;
  const height = 52;
  doc.roundedRect(MARGIN, top, width, height, 6).fillColor(colours.fill).fill();
  doc
    .font('Helvetica-Bold')
    .fontSize(24)
    .fillColor(colours.text)
    .text(report.risk.toFixed(1), MARGIN + 16, top + 14, { continued: true })
    .font('Helvetica')
    .fontSize(12)
    .text(' / 100', { continued: true })
    .font('Helvetica-Bold')
    .fontSize(14)
    .text(`      ${BAND_LABELS[report.band]}`);
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(colours.text)
    .text('Risk score: flags moments for human review', MARGIN + 16, top + 21, {
      width: width - 32,
      align: 'right',
    });
  doc.x = MARGIN;
  doc.y = top + height + 4;
}

const TABLE_COLUMNS = [
  { title: 'Category', share: 0.22, align: 'left' },
  { title: 'Flagged', share: 0.13, align: 'right' },
  { title: 'Points', share: 0.15, align: 'right' },
  { title: 'Score (max 100)', share: 0.2, align: 'right' },
  { title: 'Weight', share: 0.13, align: 'right' },
  { title: 'Adds to risk', share: 0.17, align: 'right' },
] as const;

function tableRow(doc: Pdf, cells: readonly string[], bold: boolean, shade: boolean): void {
  const width = contentWidth(doc);
  const y = doc.y;
  if (shade)
    doc
      .rect(MARGIN, y - 4, width, 18)
      .fillColor(SHADE)
      .fill();
  doc
    .font(bold ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(9.5)
    .fillColor(INK);
  let x = MARGIN;
  TABLE_COLUMNS.forEach((col, i) => {
    const w = col.share * width;
    doc.text(cells[i] ?? '', x + 4, y, { width: w - 8, align: col.align, lineBreak: false });
    x += w;
  });
  doc.x = MARGIN;
  doc.y = y + 18;
}

function categoryTable(doc: Pdf, report: SessionReport): void {
  ensureSpace(doc, 18 * (report.categories.length + 2) + 10);
  tableRow(
    doc,
    TABLE_COLUMNS.map((c) => c.title),
    true,
    true,
  );
  for (const c of report.categories) {
    const n = report.violations.filter((v) => v.category === c.category).length;
    tableRow(
      doc,
      [
        CATEGORY_LABELS[c.category],
        String(n),
        num(c.rawPoints),
        c.capped ? `${c.score.toFixed(1)} (capped)` : c.score.toFixed(1),
        `× ${num(c.weight)}`,
        c.contribution.toFixed(1),
      ],
      false,
      false,
    );
  }
  tableRow(doc, ['Risk score', '', '', '', '', report.risk.toFixed(1)], true, true);
  doc.moveDown(0.4);
}

/** Approximate height of one flagged moment in the PDF. */
const MOMENT_HEIGHT = 150;

function flaggedMoments(doc: Pdf, report: SessionReport): void {
  const width = contentWidth(doc);
  const explained = new Map(report.explanation.violations.map((e) => [e.id, e]));
  report.violations.forEach((v, i) => {
    const e = explained.get(v.id);
    if (!e) return;
    // Keep each moment on a single page.
    ensureSpace(doc, MOMENT_HEIGHT);
    if (i > 0 && doc.y > MARGIN) {
      rule(doc, doc.y + 2);
      doc.moveDown(0.7);
    }
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(INK)
      .text(`${String(i + 1)}. ${e.label}`, MARGIN, doc.y, { width, continued: true })
      .font('Helvetica')
      .fontSize(9.5)
      .fillColor(MUTED)
      .text(`    ${e.offset} into the session, ${clock(v.firstTs)}`);
    doc.moveDown(0.15);
    const severity = SEVERITY_LABELS[report.policySnapshot.severityByType[v.type]];
    doc.text(
      `${CATEGORY_LABELS[v.category]} · ${severity} severity · confidence ${String(Math.round(v.confidence * 100))}% · ${num(v.points)} points`,
      MARGIN,
      doc.y,
      { width },
    );
    doc.moveDown(0.3);
    const missing = v.evidence.filter((ev) => !ev.uploaded).length;
    const evidenceText =
      `${e.evidence}.` +
      (missing > 0 ? ` ${String(missing)} not received yet.` : '') +
      ' View it in the reviewer dashboard.';
    labelled(doc, 'What was detected:', e.meaning);
    labelled(doc, 'How often:', e.occurrences);
    labelled(doc, 'Points:', e.points);
    labelled(doc, 'Evidence:', evidenceText);
    labelled(doc, 'What to check:', e.check);
  });
}

function policyUsed(doc: Pdf, report: SessionReport): void {
  const p = report.policySnapshot;
  paragraph(
    doc,
    `Weights: browser ${num(p.weights.browser)}, video ${num(p.weights.video)}, audio ${num(p.weights.audio)}. ` +
      `Severity points: low ${num(p.severityPoints.low)}, medium ${num(p.severityPoints.medium)}, high ${num(p.severityPoints.high)}. ` +
      `Bands: Low up to ${num(p.bands.lowMax)}, Medium up to ${num(p.bands.mediumMax)}, High above. ` +
      `Merge window ${num(p.merge.windowSeconds)} s. Webcam: ${num(p.sampling.framesPerWindow)} frames per ${num(p.sampling.windowSeconds)} s. ` +
      `Evidence kept ${num(p.retentionDays)} days.` +
      (report.session.policyVersionId ? ` Policy version ${report.session.policyVersionId}.` : ''),
    9.5,
  );
  paragraph(doc, `Face matching: ${FACE_MATCH_STATUS_LABELS[report.faceMatch]}`, 9.5);
  paragraph(
    doc,
    'Severity by type: ' +
      VIOLATION_TYPES.map(
        (t) => `${VIOLATION_LABELS[t]} ${SEVERITY_LABELS[p.severityByType[t]].toLowerCase()}`,
      ).join('; ') +
      '.',
    9.5,
    MUTED,
  );
}

/** "page i of n" on every page; pages are buffered until the end so n is known. */
function pageFooters(doc: Pdf, report: SessionReport): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing inside the margin must not open a new page
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(
        `Hawkeye · session ${report.session.id} · advisory report · page ${String(i + 1)} of ${String(range.count)}`,
        MARGIN,
        doc.page.height - MARGIN + 16,
        { width: contentWidth(doc), align: 'center', lineBreak: false },
      );
    doc.page.margins.bottom = bottom;
  }
}

/** Server-side PDF export, written so a reviewer can follow it without the dashboard. */
export function renderReportPdf(report: SessionReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      bufferPages: true,
      info: { Title: `Hawkeye session report ${report.session.candidateRef}`, Creator: 'Hawkeye' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text('Hawkeye session report');
    paragraph(
      doc,
      `Generated ${time(Date.parse(report.generatedAt))}. This report is advisory: it points a reviewer to moments worth checking and does not decide any result.`,
      9,
      MUTED,
    );
    doc.moveDown(0.3);
    details(doc, report);
    scoreBox(doc, report);

    heading(doc, 'Summary');
    for (const line of report.explanation.summary) paragraph(doc, line);

    heading(doc, 'How the score was calculated');
    for (const line of report.explanation.scoring) bullet(doc, line, 9.5);
    doc.moveDown(0.5);
    categoryTable(doc, report);
    for (const line of report.explanation.categories) bullet(doc, line, 9.5, MUTED);
    doc.moveDown(0.2);
    paragraph(
      doc,
      report.reproducible
        ? 'Score check: recalculating from the stored flagged moments and the policy below gives the same score.'
        : 'Score check: recalculating from the stored flagged moments and the policy below gives a different score from the one stored. Use this report with care and tell the system administrator.',
      9,
      MUTED,
    );

    heading(doc, `Flagged moments (${String(report.violations.length)})`, 20 + MOMENT_HEIGHT);
    if (report.violations.length === 0) paragraph(doc, 'Nothing was flagged in this session.');
    else paragraph(doc, 'In order of time. Each moment links to evidence.', 9.5, MUTED);
    flaggedMoments(doc, report);

    heading(doc, 'Policy used');
    policyUsed(doc, report);

    heading(doc, 'What this system cannot see');
    for (const l of report.limitations) bullet(doc, l, 9, MUTED);

    pageFooters(doc, report);
    doc.end();
  });
}
