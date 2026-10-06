import type { Policy } from './policy';
import type { BrowserLogEntry } from './rules';

export interface CaptureWindow {
  /** Inclusive bounds, epoch ms. */
  from: number;
  to: number;
  events: BrowserLogEntry[];
}

/** FR6: the browser event sequence from `eventsBeforeSeconds` before to `eventsAfterSeconds` after. */
export function buildCaptureWindow(
  anomalyTs: number,
  log: readonly BrowserLogEntry[],
  policy: Policy,
): CaptureWindow {
  const from = anomalyTs - policy.capture.eventsBeforeSeconds * 1000;
  const to = captureWindowClosesAt(anomalyTs, policy);
  const events = log
    .filter((e) => e.ts >= from && e.ts <= to)
    .map((e) => ({ type: e.type, ts: e.ts }))
    .sort((a, b) => a.ts - b.ts);
  return { from, to, events };
}

/** The earliest time at which the capture window for `anomalyTs` is complete. */
export function captureWindowClosesAt(anomalyTs: number, policy: Policy): number {
  return anomalyTs + policy.capture.eventsAfterSeconds * 1000;
}
