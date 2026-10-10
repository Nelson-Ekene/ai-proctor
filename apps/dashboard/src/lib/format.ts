/** Scores are shown with one decimal, as in the PRD sample ("49.0"). */
export function score(n: number): string {
  return n.toFixed(1);
}

/** Points with at most two decimals and no trailing zeros ("15", "13.5", "9.99"). */
export function points(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export function dateTime(value: string | number): string {
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

/** Time since the session started, e.g. "+07:05" or "+1:02:30". */
export function offset(ms: number, startMs: number): string {
  const total = Math.max(0, Math.round((ms - startMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `+${String(h)}:${pad(m)}:${pad(s)}` : `+${pad(m)}:${pad(s)}`;
}

/** An event's time relative to its anomaly, e.g. "-4.0 s", "0 s", "+9.0 s". */
export function relative(ms: number, anchorMs: number): string {
  const d = (ms - anchorMs) / 1000;
  if (Math.abs(d) < 0.05) return '0 s';
  return `${d > 0 ? '+' : '-'}${Math.abs(d).toFixed(1)} s`;
}
