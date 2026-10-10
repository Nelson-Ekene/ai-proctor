import { FLAGGED_FOR_REVIEW } from '@proctor/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { BandBadge } from '../components/BandBadge';
import { CategoryTable } from '../components/CategoryTable';
import { EvidenceViewer } from '../components/EvidenceViewer';
import { PolicySummary } from '../components/PolicySummary';
import { Timeline } from '../components/Timeline';
import { ViolationTable } from '../components/ViolationTable';
import { dateTime, score } from '../lib/format';
import { STATUS_LABELS } from '../lib/labels';
import { Link } from '../lib/router';

async function download(sessionId: string, format: 'pdf' | 'json') {
  const blob = await api.exportReport(sessionId, format);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `session-${sessionId}.${format}`;
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

export function ReportPage({ sessionId }: { sessionId: string }) {
  const report = useQuery({
    queryKey: ['report', sessionId],
    queryFn: () => api.report(sessionId),
  });
  const [selected, setSelected] = useState<string | undefined>();
  const [exportError, setExportError] = useState<string | null>(null);

  if (report.isPending) return <p className="text-slate-600">Loading report…</p>;
  if (report.isError) {
    return (
      <p className="text-rose-700">
        {report.error instanceof ApiError && report.error.status === 404
          ? 'Session not found.'
          : 'Could not load this report.'}
      </p>
    );
  }

  const r = report.data;
  const startMs = Date.parse(r.session.startedAt);
  const endMs = r.session.endedAt ? Date.parse(r.session.endedAt) : startMs;
  const current = r.violations.find((v) => v.id === selected);

  const exportButton = (format: 'pdf' | 'json', label: string) => (
    <button
      type="button"
      onClick={() => {
        setExportError(null);
        download(r.session.id, format).catch(() => {
          setExportError('Could not export the report. Try again.');
        });
      }}
      className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-100"
    >
      {label}
    </button>
  );

  return (
    <article className="space-y-6">
      <div>
        <Link to="/" className="text-sm text-sky-800 hover:underline">
          ← All sessions
        </Link>
      </div>
      <header className="flex flex-wrap items-start gap-6 rounded-lg border border-slate-200 bg-white p-5">
        <div className="mr-auto">
          <h1 className="text-xl font-semibold">{r.session.candidateRef}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {dateTime(r.session.startedAt)}
            {r.session.endedAt ? ` – ${dateTime(r.session.endedAt)}` : ''} ·{' '}
            {STATUS_LABELS[r.session.status]}
          </p>
          <p className="mt-1 text-xs text-slate-500">Session {r.session.id}</p>
        </div>
        <div className="text-right">
          <p className="text-sm text-slate-500">Risk score</p>
          <p className="text-4xl font-semibold tabular-nums" data-testid="risk-score">
            {score(r.risk)}
          </p>
          <BandBadge band={r.band} />
          <p className="mt-2 text-sm text-slate-600">
            {r.violations.length} {FLAGGED_FOR_REVIEW.toLowerCase()}
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2">
          {exportButton('pdf', 'Export PDF')}
          {exportButton('json', 'Export JSON')}
          {exportError && <span className="text-sm text-rose-700">{exportError}</span>}
          <span className="ml-auto text-xs text-slate-500">
            {r.reproducible
              ? 'Score recomputed from the stored violations and the policy snapshot.'
              : 'Note: the recomputed score differs from the stored score.'}
          </span>
        </div>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="mb-2 font-semibold">How the score is made up</h2>
        <CategoryTable categories={r.categories} risk={r.risk} />
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="mb-3 font-semibold">Timeline</h2>
        <Timeline
          violations={r.violations}
          startMs={startMs}
          endMs={endMs}
          selectedId={selected}
          onSelect={setSelected}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-5">
        <section className="rounded-lg border border-slate-200 bg-white p-5 lg:col-span-3">
          <h2 className="mb-2 font-semibold">{FLAGGED_FOR_REVIEW}</h2>
          <ViolationTable
            violations={r.violations}
            policy={r.policySnapshot}
            startMs={startMs}
            selectedId={selected}
            onSelect={setSelected}
          />
        </section>
        <div className="lg:col-span-2">
          {current ? (
            <EvidenceViewer
              sessionId={r.session.id}
              violation={current}
              policy={r.policySnapshot}
            />
          ) : (
            r.violations.length > 0 && (
              <p className="rounded-lg border border-dashed border-slate-300 p-5 text-sm text-slate-600">
                Select a flagged moment to see its evidence.
              </p>
            )
          )}
        </div>
      </div>

      <PolicySummary policy={r.policySnapshot} versionId={r.session.policyVersionId} />

      <footer className="rounded-lg bg-slate-100 p-4 text-xs text-slate-600">
        <h2 className="mb-1 font-semibold">Limitations</h2>
        <ul className="list-disc space-y-0.5 pl-4">
          {r.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </footer>
    </article>
  );
}
