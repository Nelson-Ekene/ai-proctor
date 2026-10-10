import { describe, expect, it } from 'vitest';
import {
  EventSequenceSchema,
  openAnomaly,
  packageAnomaly,
  partitionClosed,
} from './capture-package';
import { DEFAULT_POLICY } from './policy';
import type { BrowserLogEntry } from './rules';
import { AnomalySchema, type PendingAnomaly } from './schemas';

const S = 1000;
const T = 100 * S;

const detected: PendingAnomaly = { type: 'phone_detected', ts: T, confidence: 0.8 };

const logAtDetection: BrowserLogEntry[] = [
  { type: 'copy', ts: T - 31 * S }, // outside the window
  { type: 'window_blur', ts: T - 20 * S },
  { type: 'window_focus', ts: T - 10 * S },
];

describe('openAnomaly', () => {
  it('snapshots the "before" events and computes when the window closes', () => {
    const open = openAnomaly(detected, 'a1', logAtDetection, DEFAULT_POLICY);
    expect(open).toMatchObject({ id: 'a1', type: 'phone_detected', closesAt: T + 15 * S });
    expect(open.before.map((e) => e.type)).toEqual(['window_blur', 'window_focus']);
  });
});

describe('partitionClosed', () => {
  it('separates closed from still-open windows', () => {
    const a = openAnomaly(detected, 'a', [], DEFAULT_POLICY);
    const b = openAnomaly({ ...detected, ts: T + 20 * S }, 'b', [], DEFAULT_POLICY);
    const { closed, stillOpen } = partitionClosed([a, b], T + 15 * S);
    expect(closed.map((x) => x.id)).toEqual(['a']);
    expect(stillOpen.map((x) => x.id)).toEqual(['b']);
  });
});

describe('packageAnomaly', () => {
  it('combines the snapshot with later events, even after the log dropped old ones', () => {
    const open = openAnomaly(detected, 'a1', logAtDetection, DEFAULT_POLICY);
    // By packaging time the rolling log no longer holds the "before" events.
    const logAtClose: BrowserLogEntry[] = [
      { type: 'paste', ts: T + 5 * S },
      { type: 'window_focus', ts: T - 10 * S }, // duplicate of the snapshot
      { type: 'cut', ts: T + 16 * S }, // after the window
    ];
    const pkg = packageAnomaly(open, logAtClose, [], 'seq1', DEFAULT_POLICY);
    expect(pkg.eventSequence).toEqual({
      from: T - 30 * S,
      to: T + 15 * S,
      events: [
        { type: 'window_blur', ts: T - 20 * S },
        { type: 'window_focus', ts: T - 10 * S },
        { type: 'paste', ts: T + 5 * S },
      ],
    });
  });

  it('always links evidence: own frames, overlapping clips and the event sequence', () => {
    const withFrames = openAnomaly(
      {
        ...detected,
        evidence: [
          { id: 'f1', kind: 'frame', ts: T },
          { id: 'f2', kind: 'frame', ts: T + S },
        ],
      },
      'a1',
      [],
      DEFAULT_POLICY,
    );
    const clips = [
      { id: 'c-old', kind: 'audio' as const, ts: T - 61 * S }, // too early to overlap
      { id: 'c-in', kind: 'audio' as const, ts: T - 50 * S }, // may still be playing at T-30
      { id: 'c-late', kind: 'audio' as const, ts: T + 16 * S }, // after the window
      { id: 'f1', kind: 'frame' as const, ts: T }, // not a clip
    ];
    const pkg = packageAnomaly(withFrames, [], clips, 'seq1', DEFAULT_POLICY);
    expect(pkg.anomaly.evidence.map((e) => e.id)).toEqual(['f1', 'f2', 'c-in', 'seq1']);
    expect(() => AnomalySchema.parse(pkg.anomaly)).not.toThrow();
  });

  it('a browser anomaly with no media still links its event sequence', () => {
    const open = openAnomaly(
      { type: 'copy_paste', ts: T, confidence: 1 },
      'b1',
      [],
      DEFAULT_POLICY,
    );
    const pkg = packageAnomaly(open, [], [], 'seq2', DEFAULT_POLICY);
    expect(pkg.anomaly).toEqual({
      id: 'b1',
      type: 'copy_paste',
      ts: T,
      confidence: 1,
      evidence: [{ id: 'seq2', kind: 'event_sequence', ts: T }],
    });
  });

  it('does not duplicate a clip already linked to an audio anomaly', () => {
    const clip = { id: 'c1', kind: 'audio' as const, ts: T };
    const open = openAnomaly(
      { type: 'speech_detected', ts: T, confidence: 0.9, evidence: [clip] },
      's1',
      [],
      DEFAULT_POLICY,
    );
    const pkg = packageAnomaly(open, [], [clip], 'seq3', DEFAULT_POLICY);
    expect(pkg.anomaly.evidence.map((e) => e.id)).toEqual(['c1', 'seq3']);
  });
});

describe('EventSequenceSchema', () => {
  it('accepts a packaged event sequence', () => {
    const log: BrowserLogEntry[] = [{ type: 'window_blur', ts: 100_000 }];
    const open = openAnomaly(
      { type: 'tab_switch_or_blur', ts: 100_000, confidence: 1 },
      'a',
      log,
      DEFAULT_POLICY,
    );
    const pkg = packageAnomaly(open, log, [], 'seq', DEFAULT_POLICY);
    expect(EventSequenceSchema.parse(pkg.eventSequence)).toEqual(pkg.eventSequence);
  });

  it('refuses anything beyond event type and timestamp', () => {
    const extra = { from: 0, to: 1, events: [{ type: 'window_blur', ts: 0, url: 'https://x' }] };
    expect(EventSequenceSchema.safeParse(extra).success).toBe(false);
    expect(EventSequenceSchema.safeParse({ from: 0, to: 1, events: [], text: 'x' }).success).toBe(
      false,
    );
  });
});
