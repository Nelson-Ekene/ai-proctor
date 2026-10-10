import { CATEGORY_LABELS, type CategoryResult } from '@proctor/core';
import { points, score } from '../lib/format';

/**
 * Per-category contribution, as in the PRD sample: category score (points capped at 100) x
 * weight = contribution; the contributions add up to the risk score.
 */
export function CategoryTable({
  categories,
  risk,
}: {
  categories: CategoryResult[];
  risk: number;
}) {
  return (
    <table className="w-full text-sm" aria-label="Contribution by category">
      <thead>
        <tr className="border-b border-slate-200 text-left text-slate-500">
          <th className="py-2 pr-3 font-medium">Category</th>
          <th className="py-2 pr-3 text-right font-medium">Points</th>
          <th className="py-2 pr-3 text-right font-medium">Score (max 100)</th>
          <th className="py-2 pr-3 text-right font-medium">Weight</th>
          <th className="py-2 text-right font-medium">Contribution</th>
        </tr>
      </thead>
      <tbody>
        {categories.map((c) => (
          <tr key={c.category} className="border-b border-slate-100">
            <th scope="row" className="py-2 pr-3 text-left font-medium">
              {CATEGORY_LABELS[c.category]}
            </th>
            <td className="py-2 pr-3 text-right tabular-nums">{points(c.rawPoints)}</td>
            <td className="py-2 pr-3 text-right tabular-nums">
              {score(c.score)}
              {c.capped && <span className="ml-1 text-xs text-slate-500">(capped)</span>}
            </td>
            <td className="py-2 pr-3 text-right tabular-nums">{Math.round(c.weight * 100)}%</td>
            <td className="py-2 text-right tabular-nums">{score(c.contribution)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" colSpan={4} className="py-2 pr-3 text-right font-semibold">
            Risk score
          </th>
          <td className="py-2 text-right font-semibold tabular-nums">{score(risk)}</td>
        </tr>
      </tfoot>
    </table>
  );
}
