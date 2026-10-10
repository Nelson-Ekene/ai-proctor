import { BAND_LABELS, type RiskBand } from '@proctor/core';

const STYLE: Record<RiskBand, string> = {
  low: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
  medium: 'bg-amber-100 text-amber-900 ring-amber-300',
  high: 'bg-rose-100 text-rose-800 ring-rose-300',
};

export function BandBadge({ band }: { band: RiskBand }) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${STYLE[band]}`}
    >
      {BAND_LABELS[band]}
    </span>
  );
}
