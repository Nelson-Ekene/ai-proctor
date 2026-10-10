import { SEVERITY_LABELS, VIOLATION_LABELS, VIOLATION_TYPES, type Policy } from '@proctor/core';

/** The policy a report was scored with (the session's snapshot). */
export function PolicySummary({ policy, versionId }: { policy: Policy; versionId: string | null }) {
  const w = policy.weights;
  return (
    <details className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <summary className="cursor-pointer font-semibold">
        Policy used for this score{' '}
        <span className="font-normal text-slate-500">
          ({versionId ? `version ${versionId.slice(0, 8)}` : 'default policy'})
        </span>
      </summary>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
        <dt className="text-slate-500">Weights</dt>
        <dd>
          Browser {Math.round(w.browser * 100)}%, video {Math.round(w.video * 100)}%, audio{' '}
          {Math.round(w.audio * 100)}%
        </dd>
        <dt className="text-slate-500">Bands</dt>
        <dd>
          Low up to {policy.bands.lowMax}, medium up to {policy.bands.mediumMax}, high above
        </dd>
        <dt className="text-slate-500">Severity points</dt>
        <dd>
          Low {policy.severityPoints.low}, medium {policy.severityPoints.medium}, high{' '}
          {policy.severityPoints.high}
        </dd>
        <dt className="text-slate-500">Merge window</dt>
        <dd>
          {policy.merge.windowSeconds} s
          {policy.merge.countMultipliesPoints ? ' (count multiplies points)' : ''}
        </dd>
        <dt className="text-slate-500">Webcam sampling</dt>
        <dd>
          {policy.sampling.framesPerWindow} frames per {policy.sampling.windowSeconds} s
        </dd>
        <dt className="text-slate-500">Retention</dt>
        <dd>{policy.retentionDays} days</dd>
      </dl>
      <table className="mt-3 w-full max-w-md text-sm">
        <caption className="text-left text-slate-500">Severity per type</caption>
        <tbody>
          {VIOLATION_TYPES.map((t) => (
            <tr key={t} className="border-b border-slate-100">
              <td className="py-0.5 pr-3">{VIOLATION_LABELS[t]}</td>
              <td className="py-0.5">{SEVERITY_LABELS[policy.severityByType[t]]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
