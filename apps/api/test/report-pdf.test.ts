import { DEFAULT_POLICY, REPORT_LIMITATIONS, computeRisk, explainReport } from '@proctor/core';
import { describe, expect, it } from 'vitest';
import { renderReportPdf, type ReportViolation, type SessionReport } from '../src/report';

// The PDF renderer is pure (report in, bytes out), so it is tested without the database.

const START = Date.UTC(2026, 9, 10, 19, 44, 3);
const MIN = 60_000;

function violation(i: number): ReportViolation {
  const ts = START + (i + 1) * MIN;
  return {
    id: `v${String(i)}`,
    type: i % 2 === 0 ? 'phone_detected' : 'tab_switch_or_blur',
    category: i % 2 === 0 ? 'video' : 'browser',
    severity: i % 2 === 0 ? 'high' : 'medium',
    confidence: i % 2 === 0 ? 0.81 : 1,
    firstTs: ts,
    lastTs: ts,
    count: 1,
    anomalyIds: [`a${String(i)}`],
    label: '',
    points: 0,
    evidence: [{ id: `e${String(i)}`, kind: 'frame', ts, uploaded: i !== 1 }],
  };
}

function sampleReport(n: number, endedAt: string | null): SessionReport {
  const stored = Array.from({ length: n }, (_, i) => violation(i));
  const scored = computeRisk(
    stored.map(({ label: _l, points: _p, evidence, ...v }) => ({
      ...v,
      evidence: evidence.map(({ uploaded: _u, ...e }) => e),
    })),
    DEFAULT_POLICY,
  );
  const violations = stored.map((v, i) => ({ ...v, points: scored.violations[i]?.points ?? 0 }));
  return {
    session: {
      id: '3522c904-e15e-49c2-911b-bb86099a97a0',
      examId: 'exam-1',
      candidateRef: 'demo-candidate',
      status: 'ended',
      startedAt: new Date(START).toISOString(),
      endedAt,
      policyVersionId: 'policy-1',
    },
    risk: scored.risk,
    band: scored.band,
    categories: scored.categories,
    violations,
    policySnapshot: DEFAULT_POLICY,
    faceMatch: 'not_offered',
    reproducible: n !== 0,
    explanation: explainReport({
      risk: scored.risk,
      band: scored.band,
      categories: scored.categories,
      violations,
      policy: DEFAULT_POLICY,
      startMs: START,
    }),
    limitations: REPORT_LIMITATIONS,
    generatedAt: new Date(START + 2 * 60 * MIN).toISOString(),
  };
}

function pageCount(pdf: Buffer): number {
  return pdf.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0;
}

describe('renderReportPdf', () => {
  it('renders a long report over several pages', async () => {
    const pdf = await renderReportPdf(sampleReport(20, new Date(START + 80 * MIN).toISOString()));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pageCount(pdf)).toBeGreaterThan(3);
  });

  it('renders an empty, unfinished session', async () => {
    const pdf = await renderReportPdf(sampleReport(0, null));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(1);
  });
});
