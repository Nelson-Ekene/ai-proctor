import {
  computeRisk,
  BAND_LABELS,
  REPORT_LIMITATIONS,
  VIOLATION_LABELS,
  type CategoryResult,
  type EvidenceRef,
  type Policy,
  type RiskBand,
  type Violation,
} from '@proctor/core';
import { eq } from 'drizzle-orm';
import PDFDocument from 'pdfkit';
import type { Db } from './db/client';
import { evidence, sessions } from './db/schema';
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
  /** True when the recomputed score equals the score stored at ingest time. */
  reproducible: boolean;
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
  const points = new Map(scored.violations.map((v) => [v.violationId, v.points]));

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
    violations: stored.map((v) => ({
      ...v,
      label: VIOLATION_LABELS[v.type],
      points: points.get(v.id) ?? 0,
      evidence: v.evidence.map((e) => ({ ...e, uploaded: uploaded.has(e.id) })),
    })),
    policySnapshot: scored.policySnapshot,
    reproducible: scored.risk === session.risk && scored.band === session.band,
    limitations: REPORT_LIMITATIONS,
    generatedAt: now.toISOString(),
  };
}

function time(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC');
}

/** Server-side PDF export of a report. */
export function renderReportPdf(report: SessionReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: 'Session report' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);

    doc.fontSize(18).text('Proctoring session report');
    doc.fontSize(9).fillColor('#555').text(`Generated ${report.generatedAt}`).fillColor('black');
    doc.moveDown();
    doc.fontSize(11);
    doc.text(`Session: ${report.session.id}`);
    doc.text(`Candidate reference: ${report.session.candidateRef}`);
    if (report.session.examId) doc.text(`Exam: ${report.session.examId}`);
    doc.text(`Started: ${report.session.startedAt}`);
    doc.text(`Ended: ${report.session.endedAt ?? 'not ended'}`);
    doc.moveDown();
    doc
      .fontSize(14)
      .text(`Risk score ${report.risk.toFixed(1)} / 100 — ${BAND_LABELS[report.band]}`);
    doc.fontSize(10).text('Flagged moments are for human review; this report is advisory.');
    doc.moveDown();

    doc.fontSize(12).text('Contribution by category');
    doc.fontSize(10);
    for (const c of report.categories) {
      doc.text(
        `${c.category}: score ${c.score.toFixed(1)} × weight ${String(c.weight)} = ${c.contribution.toFixed(1)}${c.capped ? ' (capped at 100)' : ''}`,
      );
    }
    doc.moveDown();

    doc.fontSize(12).text(`Flagged for review (${String(report.violations.length)})`);
    doc.fontSize(10);
    if (report.violations.length === 0) doc.text('Nothing was flagged in this session.');
    for (const v of report.violations) {
      doc.text(
        `${time(v.firstTs)}  ${v.label} — ${v.category}, ${v.severity} severity, confidence ${v.confidence.toFixed(2)}, ×${String(v.count)}, ${v.points.toFixed(1)} points, evidence: ${v.evidence.map((e) => e.kind).join(', ')}`,
      );
    }
    doc.moveDown();

    const p = report.policySnapshot;
    doc.fontSize(12).text('Policy used');
    doc
      .fontSize(10)
      .text(
        `Weights: browser ${String(p.weights.browser)}, video ${String(p.weights.video)}, audio ${String(p.weights.audio)}. ` +
          `Bands: low up to ${String(p.bands.lowMax)}, medium up to ${String(p.bands.mediumMax)}. ` +
          `Merge window ${String(p.merge.windowSeconds)} s. Retention ${String(p.retentionDays)} days.`,
      );
    doc.moveDown();

    doc.fontSize(12).text('Limitations');
    doc.fontSize(9);
    for (const l of report.limitations) doc.text(`• ${l}`);
    doc.end();
  });
}
