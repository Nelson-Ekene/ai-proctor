import { CATEGORY_LABELS, type Category } from '@proctor/core';
import type { ReportViolation } from '../api/types';
import { offset } from '../lib/format';

export const CATEGORY_COLOUR: Record<Category, string> = {
  browser: 'bg-sky-500',
  video: 'bg-violet-500',
  audio: 'bg-orange-500',
};

/** Flagged moments placed on the session's time axis, in order of occurrence. */
export function Timeline({
  violations,
  startMs,
  endMs,
  selectedId,
  onSelect,
}: {
  violations: ReportViolation[];
  startMs: number;
  endMs: number;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const last = Math.max(endMs, ...violations.map((v) => v.lastTs));
  const span = Math.max(1, last - startMs);
  const at = (ms: number) => `${String(((ms - startMs) / span) * 100)}%`;

  return (
    <div>
      <ul className="relative h-10 rounded bg-slate-100" aria-label="Timeline">
        {violations.map((v) => (
          <li
            key={v.id}
            className="absolute top-1.5 h-7 -translate-x-1/2"
            style={{
              left: at(v.firstTs),
              width: `max(0.5rem, calc(${at(v.lastTs)} - ${at(v.firstTs)}))`,
            }}
          >
            <button
              type="button"
              title={`${v.label} at ${offset(v.firstTs, startMs)}`}
              aria-label={`${v.label} at ${offset(v.firstTs, startMs)}`}
              aria-pressed={v.id === selectedId}
              onClick={() => {
                onSelect(v.id);
              }}
              className={`block h-full w-full rounded-sm ${CATEGORY_COLOUR[v.category]} ${v.id === selectedId ? 'ring-2 ring-slate-900 ring-offset-1' : 'opacity-80 hover:opacity-100'}`}
            />
          </li>
        ))}
      </ul>
      <div className="mt-1 flex justify-between text-xs text-slate-500">
        <span>Start</span>
        <span>{offset(last, startMs)}</span>
      </div>
      <div className="mt-2 flex gap-4 text-xs text-slate-600">
        {(['browser', 'video', 'audio'] as const).map((c) => (
          <span key={c} className="flex items-center gap-1">
            <span className={`inline-block h-2.5 w-2.5 rounded-sm ${CATEGORY_COLOUR[c]}`} />
            {CATEGORY_LABELS[c]}
          </span>
        ))}
      </div>
    </div>
  );
}
