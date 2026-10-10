import { CATEGORY_LABELS, SEVERITY_LABELS, type Policy } from '@proctor/core';
import type { ReportViolation } from '../api/types';
import { offset, points } from '../lib/format';

/** How a violation's points were computed under the session's policy. */
export function pointsFormula(v: ReportViolation, policy: Policy): string {
  const base = policy.severityPoints[v.severity];
  const count = policy.merge.countMultipliesPoints && v.count > 1 ? ` × ${String(v.count)}` : '';
  return `${String(base)} × ${v.confidence.toFixed(2)}${count} = ${points(v.points)}`;
}

export function ViolationTable({
  violations,
  policy,
  startMs,
  selectedId,
  onSelect,
}: {
  violations: ReportViolation[];
  policy: Policy;
  startMs: number;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  if (violations.length === 0) {
    return (
      <p className="text-sm text-slate-600">Nothing was flagged for review in this session.</p>
    );
  }
  return (
    <table className="w-full text-sm" aria-label="Flagged moments">
      <thead>
        <tr className="border-b border-slate-200 text-left text-slate-500">
          <th className="py-2 pr-3 font-medium">Time</th>
          <th className="py-2 pr-3 font-medium">Flagged moment</th>
          <th className="py-2 pr-3 font-medium">Category</th>
          <th className="py-2 pr-3 font-medium">Severity</th>
          <th className="py-2 pr-3 text-right font-medium">Confidence</th>
          <th className="py-2 pr-3 text-right font-medium">Count</th>
          <th className="py-2 pr-3 text-right font-medium">Points</th>
          <th className="py-2 text-right font-medium">Evidence</th>
        </tr>
      </thead>
      <tbody>
        {violations.map((v) => {
          const selected = v.id === selectedId;
          return (
            <tr
              key={v.id}
              className={`cursor-pointer border-b border-slate-100 ${selected ? 'bg-sky-50' : 'hover:bg-slate-50'}`}
              aria-selected={selected}
              onClick={() => {
                onSelect(v.id);
              }}
            >
              <td className="py-2 pr-3 tabular-nums">{offset(v.firstTs, startMs)}</td>
              <td className="py-2 pr-3">
                <button
                  type="button"
                  className="text-left font-medium text-sky-800 hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(v.id);
                  }}
                >
                  {v.label}
                </button>
              </td>
              <td className="py-2 pr-3">{CATEGORY_LABELS[v.category]}</td>
              <td className="py-2 pr-3">{SEVERITY_LABELS[v.severity]}</td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {Math.round(v.confidence * 100)}%
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{v.count}</td>
              <td className="py-2 pr-3 text-right tabular-nums" title={pointsFormula(v, policy)}>
                {points(v.points)}
              </td>
              <td className="py-2 text-right tabular-nums">{v.evidence.length}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
