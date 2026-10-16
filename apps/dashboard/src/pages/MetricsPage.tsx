import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../api/client';
import { dateTime } from '../lib/format';

const pct = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);
const minutes = (ms: number | null) =>
  ms === null
    ? '—'
    : ms < 60_000
      ? `${String(Math.round(ms / 1000))} s`
      : `${(ms / 60_000).toFixed(1)} min`;

function Card({ title, value, note }: { title: string; value: ReactNode; note: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-sm text-slate-500">{title}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{note}</p>
    </div>
  );
}

/** Pilot metrics (BUILD_PLAN Phase 9.5) and the audit trail, for admins. */
export function MetricsPage() {
  const metrics = useQuery({ queryKey: ['metrics'], queryFn: api.metrics });
  const audit = useQuery({ queryKey: ['audit'], queryFn: () => api.audit(50) });
  const m = metrics.data;

  return (
    <section className="space-y-6">
      <h1 className="text-xl font-semibold">Metrics</h1>
      {metrics.isError && <p className="text-rose-700">Could not load metrics.</p>}
      {m && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card
            title="Flagged moments with evidence"
            value={
              <span data-testid="evidence-linked">{pct(m.violations.evidenceLinkedRate)}</span>
            }
            note={`${String(m.violations.withEvidence)} of ${String(m.violations.total)} (target 100%)`}
          />
          <Card
            title="Evidence received"
            value={pct(m.evidence.uploadedRate)}
            note={`${String(m.evidence.uploaded)} of ${String(m.evidence.referenced)} items uploaded`}
          />
          <Card
            title="Setup check completed"
            value={<span data-testid="setup-completion">{pct(m.setupCheck.completionRate)}</span>}
            note={`${String(m.setupCheck.completed)} of ${String(m.setupCheck.consented)} consented sessions; ${String(m.setupCheck.allReady)} fully ready`}
          />
          <Card
            title="Reviewer time per session"
            value={<span data-testid="review-median">{minutes(m.reviewerTime.medianMs)}</span>}
            note={`median over ${String(m.reviewerTime.reviewedSessions)} reviewed sessions; 90th percentile ${minutes(m.reviewerTime.p90Ms)}`}
          />
        </div>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 font-semibold">Audit log (latest 50)</h2>
        {audit.data && audit.data.length === 0 && (
          <p className="text-sm text-slate-600">No entries yet.</p>
        )}
        {audit.data && audit.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Audit log">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="py-2 pr-3 font-medium">Time</th>
                  <th className="py-2 pr-3 font-medium">Action</th>
                  <th className="py-2 pr-3 font-medium">Actor</th>
                  <th className="py-2 font-medium">Target</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.map((a) => (
                  <tr key={a.id} className="border-b border-slate-100">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{dateTime(a.ts)}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs">{a.action}</td>
                    <td className="py-1.5 pr-3">{a.actorType}</td>
                    <td className="py-1.5 font-mono text-xs break-all">
                      {a.targetType ? `${a.targetType}: ${a.targetId ?? ''}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
