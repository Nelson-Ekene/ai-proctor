import { buildCaptureWindow } from './capture';
import type { Policy } from './policy';
import type { BrowserLogEntry } from './rules';
import type { Anomaly, EvidenceRef, PendingAnomaly } from './schemas';

// Anomaly capture package (FR6, BUILD_PLAN Phase 6). Any anomaly (browser, video or audio)
// opens a capture window: the browser event sequence from capture.eventsBeforeSeconds before to
// capture.eventsAfterSeconds after, plus burst frames and any overlapping audio clip.
//
// The "before" part is snapshotted when the anomaly is detected, because packaging happens
// only after the window closes and the rolling log may have dropped those entries by then.

/** An anomaly waiting for its capture window to close. */
export interface OpenAnomaly extends PendingAnomaly {
  /** Stable id: also the idempotency key of its upload. */
  id: string;
  /** Time at which the capture window is complete. */
  closesAt: number;
  /** Browser events in [ts - eventsBefore, ts], snapshotted at detection. */
  before: BrowserLogEntry[];
}

export interface EventSequence {
  from: number;
  to: number;
  events: BrowserLogEntry[];
}

export interface AnomalyPackage {
  /** The record uploaded to the server: always links to at least the event sequence. */
  anomaly: Anomaly;
  eventSequence: EventSequence;
}

export function openAnomaly(
  detected: PendingAnomaly,
  id: string,
  log: readonly BrowserLogEntry[],
  policy: Policy,
): OpenAnomaly {
  const window = buildCaptureWindow(detected.ts, log, policy);
  return {
    ...detected,
    id,
    closesAt: window.to,
    before: window.events.filter((e) => e.ts <= detected.ts),
  };
}

/** Splits anomalies into those whose window has closed by `now` and those still open. */
export function partitionClosed(
  open: readonly OpenAnomaly[],
  now: number,
): { closed: OpenAnomaly[]; stillOpen: OpenAnomaly[] } {
  return {
    closed: open.filter((a) => a.closesAt <= now),
    stillOpen: open.filter((a) => a.closesAt > now),
  };
}

/**
 * Builds the package for a closed (or force-closed, at session end) anomaly.
 * `clips` are the session's stored audio clips; one overlaps the window if it started no
 * earlier than audio.maxClipSeconds before the window and before the window ended.
 */
export function packageAnomaly(
  open: OpenAnomaly,
  log: readonly BrowserLogEntry[],
  clips: readonly EvidenceRef[],
  eventSequenceId: string,
  policy: Policy,
): AnomalyPackage {
  const window = buildCaptureWindow(open.ts, log, policy);
  const eventSequence: EventSequence = {
    from: window.from,
    to: window.to,
    // Snapshot holds events up to the anomaly, the log supplies those after it: disjoint and
    // each already in time order. Copy type + ts only.
    events: [...open.before, ...window.events.filter((e) => e.ts > open.ts)].map((e) => ({
      type: e.type,
      ts: e.ts,
    })),
  };
  const earliestClipStart = window.from - policy.audio.maxClipSeconds * 1000;
  const overlapping = clips.filter(
    (c) => c.kind === 'audio' && c.ts >= earliestClipStart && c.ts <= window.to,
  );
  const evidence: EvidenceRef[] = [];
  for (const ref of [
    ...(open.evidence ?? []),
    ...overlapping,
    { id: eventSequenceId, kind: 'event_sequence' as const, ts: open.ts },
  ]) {
    if (!evidence.some((e) => e.id === ref.id)) evidence.push(ref);
  }
  return {
    anomaly: { id: open.id, type: open.type, ts: open.ts, confidence: open.confidence, evidence },
    eventSequence,
  };
}
