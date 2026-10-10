import { BAND_LABELS, RISK_BANDS } from '@proctor/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { BandBadge } from '../components/BandBadge';
import { dateTime, score } from '../lib/format';
import { STATUS_LABELS } from '../lib/labels';
import { Link, navigate, useLocation } from '../lib/router';

const PAGE_SIZE = 25;

/** Sessions ranked by risk (highest first); filters live in the URL so views can be shared. */
export function SessionsPage() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const band = params.get('band') ?? '';
  const status = params.get('status') ?? '';
  const examId = params.get('examId') ?? '';
  const page = Math.max(0, Number(params.get('page') ?? 0) || 0);

  const exams = useQuery({ queryKey: ['exams'], queryFn: api.exams });
  const list = useQuery({
    queryKey: ['sessions', band, status, examId, page],
    queryFn: () =>
      api.sessions({ band, status, examId, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    const q = next.toString();
    navigate(`/${q ? `?${q}` : ''}`);
  }

  const examName = new Map((exams.data ?? []).map((e) => [e.id, e.name]));
  const total = list.data?.total ?? 0;

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <h1 className="mr-auto text-xl font-semibold">Sessions</h1>
        <label className="text-sm">
          Risk band{' '}
          <select
            value={band}
            onChange={(e) => {
              setFilter('band', e.target.value);
            }}
            className="ml-1 rounded border border-slate-300 px-2 py-1"
          >
            <option value="">All</option>
            {RISK_BANDS.map((b) => (
              <option key={b} value={b}>
                {BAND_LABELS[b]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Status{' '}
          <select
            value={status}
            onChange={(e) => {
              setFilter('status', e.target.value);
            }}
            className="ml-1 rounded border border-slate-300 px-2 py-1"
          >
            <option value="">All</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Exam{' '}
          <select
            value={examId}
            onChange={(e) => {
              setFilter('examId', e.target.value);
            }}
            className="ml-1 rounded border border-slate-300 px-2 py-1"
          >
            <option value="">All</option>
            {(exams.data ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {list.isError && <p className="text-rose-700">Could not load sessions.</p>}
      {list.data && list.data.sessions.length === 0 && (
        <p className="text-slate-600">No sessions match these filters.</p>
      )}
      {list.data && list.data.sessions.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm" aria-label="Sessions ranked by risk">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="px-3 py-2 text-right font-medium">Risk score</th>
                <th className="px-3 py-2 font-medium">Band</th>
                <th className="px-3 py-2 font-medium">Candidate</th>
                <th className="px-3 py-2 font-medium">Exam</th>
                <th className="px-3 py-2 font-medium">Started</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Flagged for review</th>
              </tr>
            </thead>
            <tbody>
              {list.data.sessions.map((s) => (
                <tr key={s.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">
                    {score(s.risk)}
                  </td>
                  <td className="px-3 py-2">
                    <BandBadge band={s.band} />
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      to={`/sessions/${s.id}`}
                      className="font-medium text-sky-800 hover:underline"
                    >
                      {s.candidateRef}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{s.examId ? (examName.get(s.examId) ?? '—') : '—'}</td>
                  <td className="px-3 py-2">{dateTime(s.startedAt)}</td>
                  <td className="px-3 py-2">{STATUS_LABELS[s.status]}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{s.violationCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > PAGE_SIZE && (
        <div className="mt-3 flex items-center gap-3 text-sm">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => {
              setFilter('page', String(page - 1));
            }}
            className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
          >
            Previous
          </button>
          <span>
            Page {page + 1} of {Math.ceil(total / PAGE_SIZE)}
          </span>
          <button
            type="button"
            disabled={(page + 1) * PAGE_SIZE >= total}
            onClick={() => {
              setFilter('page', String(page + 1));
            }}
            className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}
