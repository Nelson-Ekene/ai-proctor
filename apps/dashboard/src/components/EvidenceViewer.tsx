import { CATEGORY_LABELS, SEVERITY_LABELS, type Policy } from '@proctor/core';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ReportEvidence, ReportViolation } from '../api/types';
import { clock, relative } from '../lib/format';
import { EVENT_LABELS, EVIDENCE_KIND_LABELS } from '../lib/labels';
import { pointsFormula } from './ViolationTable';

// Each fetch of evidence is audited by the API. Signed URLs live 60 s, so they are re-requested
// whenever the viewer opens rather than cached for long.
const URL_STALE_MS = 30_000;

/** Media first, then the browser event window. */
const KIND_ORDER = { frame: 0, audio: 1, event_sequence: 2 } as const;

function SignedMedia({ sessionId, item }: { sessionId: string; item: ReportEvidence }) {
  const q = useQuery({
    queryKey: ['evidence-url', sessionId, item.id],
    queryFn: () => api.evidenceUrl(sessionId, item.id),
    staleTime: URL_STALE_MS,
    gcTime: URL_STALE_MS,
  });
  if (q.isPending) return <p className="text-sm text-slate-500">Loading…</p>;
  if (q.isError) return <p className="text-sm text-rose-700">Could not load this item.</p>;
  return item.kind === 'frame' ? (
    <img
      src={q.data.url}
      alt={`Webcam frame at ${clock(item.ts)}`}
      className="max-h-64 rounded border border-slate-200"
    />
  ) : (
    <audio
      controls
      src={q.data.url}
      aria-label={`Audio clip at ${clock(item.ts)}`}
      className="w-full"
    />
  );
}

function EventSequenceView({ sessionId, item }: { sessionId: string; item: ReportEvidence }) {
  const q = useQuery({
    queryKey: ['evidence-events', sessionId, item.id],
    queryFn: () => api.eventSequence(sessionId, item.id),
  });
  if (q.isPending) return <p className="text-sm text-slate-500">Loading…</p>;
  if (q.isError) return <p className="text-sm text-rose-700">Could not load this item.</p>;
  const { events, from, to } = q.data;
  return (
    <div>
      <p className="mb-1 text-xs text-slate-500">
        Browser events from {relative(from, item.ts)} to {relative(to, item.ts)} around this moment
        (event type and time only).
      </p>
      {events.length === 0 ? (
        <p className="text-sm text-slate-600">No browser events in this window.</p>
      ) : (
        <ol className="text-sm" aria-label="Browser events">
          {events.map((e, i) => (
            <li
              key={`${String(e.ts)}-${String(i)}`}
              className="flex gap-3 border-b border-slate-100 py-1"
            >
              <span className="w-16 text-right tabular-nums text-slate-500">
                {relative(e.ts, item.ts)}
              </span>
              <span>{EVENT_LABELS[e.type]}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function EvidenceViewer({
  sessionId,
  violation,
  policy,
}: {
  sessionId: string;
  violation: ReportViolation;
  policy: Policy;
}) {
  return (
    <section aria-label="Evidence" className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="text-base font-semibold">{violation.label}</h3>
      <p className="mt-1 text-sm text-slate-600">
        {CATEGORY_LABELS[violation.category]} · {SEVERITY_LABELS[violation.severity]} severity ·{' '}
        {violation.count > 1 ? `${String(violation.count)} occurrences merged · ` : ''}
        Points: {pointsFormula(violation, policy)} (severity points × confidence)
      </p>
      <ul className="mt-4 space-y-4">
        {[...violation.evidence]
          .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
          .map((item) => (
            <li key={item.id}>
              <h4 className="mb-1 text-sm font-medium">
                {EVIDENCE_KIND_LABELS[item.kind]}{' '}
                <span className="font-normal text-slate-500">at {clock(item.ts)}</span>
              </h4>
              {!item.uploaded ? (
                <p className="text-sm text-slate-500">
                  Not received yet (the candidate&apos;s device may still be uploading it).
                </p>
              ) : item.kind === 'event_sequence' ? (
                <EventSequenceView sessionId={sessionId} item={item} />
              ) : (
                <SignedMedia sessionId={sessionId} item={item} />
              )}
            </li>
          ))}
      </ul>
    </section>
  );
}
