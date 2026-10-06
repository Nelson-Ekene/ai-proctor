import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './policy';
import {
  BrowserLogEntrySchema,
  RawBrowserEventSchema,
  createRuleEngineState,
  stepRuleEngine,
  type RawBrowserEvent,
  type RuleEngineState,
} from './rules';
import type { DetectedAnomaly } from './schemas';

const S = 1000;
const T0 = 1_700_000_000_000;

/** Runs events (ts relative to T0) and collects every anomaly. */
function run(
  events: RawBrowserEvent[],
  state: RuleEngineState = createRuleEngineState(T0),
): { state: RuleEngineState; anomalies: DetectedAnomaly[] } {
  const anomalies: DetectedAnomaly[] = [];
  let s = state;
  for (const e of events) {
    const step = stepRuleEngine(s, { ...e, ts: T0 + e.ts }, DEFAULT_POLICY);
    s = step.state;
    anomalies.push(...step.anomalies);
  }
  return { state: s, anomalies };
}

const types = (a: DetectedAnomaly[]) => a.map((x) => x.type);
const at = (a: DetectedAnomaly[]) => a.map((x) => x.ts - T0);

describe('browser rule engine: the five browser violation types', () => {
  it('fullscreen_exit only on a real exit from fullscreen', () => {
    const { anomalies, state } = run([
      { kind: 'fullscreenchange', ts: 0, isFullscreen: false }, // never entered: ignored
      { kind: 'fullscreenchange', ts: 1 * S, isFullscreen: true },
      { kind: 'fullscreenchange', ts: 2 * S, isFullscreen: true }, // duplicate: ignored
      { kind: 'fullscreenchange', ts: 3 * S, isFullscreen: false },
    ]);
    expect(types(anomalies)).toEqual(['fullscreen_exit']);
    expect(at(anomalies)).toEqual([3 * S]);
    expect(state.log.map((e) => e.type)).toEqual(['fullscreen_enter', 'fullscreen_exit']);
    expect(anomalies[0]?.confidence).toBe(1);
  });

  it('tab_switch_or_blur once per departure, even when hidden and blur both fire', () => {
    const { anomalies, state } = run([
      { kind: 'visibilitychange', ts: 1 * S, hidden: true },
      { kind: 'blur', ts: 1 * S },
      { kind: 'visibilitychange', ts: 5 * S, hidden: false },
      { kind: 'focus', ts: 5 * S },
      { kind: 'blur', ts: 9 * S }, // second departure (window blur only)
      { kind: 'blur', ts: 10 * S }, // still away: ignored
      { kind: 'focus', ts: 12 * S },
    ]);
    expect(types(anomalies)).toEqual(['tab_switch_or_blur', 'tab_switch_or_blur']);
    expect(at(anomalies)).toEqual([1 * S, 9 * S]);
    expect(state.log.map((e) => e.type)).toEqual([
      'visibility_hidden',
      'window_blur',
      'visibility_visible',
      'window_focus',
      'window_blur',
      'window_focus',
    ]);
  });

  it('stays away until both visible and focused', () => {
    const { anomalies } = run([
      { kind: 'blur', ts: 0 },
      { kind: 'visibilitychange', ts: 1 * S, hidden: true },
      { kind: 'focus', ts: 2 * S }, // still hidden: still away
      { kind: 'visibilitychange', ts: 3 * S, hidden: true }, // no change
      { kind: 'visibilitychange', ts: 4 * S, hidden: false },
    ]);
    expect(types(anomalies)).toEqual(['tab_switch_or_blur']);
  });

  it('ignores focus and visible events when already present', () => {
    const { anomalies, state } = run([
      { kind: 'focus', ts: 0 },
      { kind: 'visibilitychange', ts: 1, hidden: false },
    ]);
    expect(anomalies).toEqual([]);
    expect(state.log).toEqual([]);
  });

  it('copy_paste for copy, cut and paste', () => {
    const { anomalies, state } = run([
      { kind: 'copy', ts: 1 * S },
      { kind: 'cut', ts: 2 * S },
      { kind: 'paste', ts: 3 * S },
    ]);
    expect(types(anomalies)).toEqual(['copy_paste', 'copy_paste', 'copy_paste']);
    expect(state.log.map((e) => e.type)).toEqual(['copy', 'cut', 'paste']);
  });

  it('refresh_attempt for beforeunload and refresh keys', () => {
    const { anomalies, state } = run([
      { kind: 'refresh_key', ts: 1 * S },
      { kind: 'beforeunload', ts: 2 * S },
    ]);
    expect(types(anomalies)).toEqual(['refresh_attempt', 'refresh_attempt']);
    expect(state.log.map((e) => e.type)).toEqual(['refresh_attempt', 'refresh_attempt']);
  });

  it('inactivity once per idle period, stamped when the threshold was crossed', () => {
    const { anomalies, state } = run([
      { kind: 'tick', ts: 59.999 * S },
      { kind: 'tick', ts: 90 * S }, // noticed late
      { kind: 'tick', ts: 200 * S }, // same idle period: no repeat
    ]);
    expect(types(anomalies)).toEqual(['inactivity']);
    expect(at(anomalies)).toEqual([60 * S]);
    expect(state.idleFlagged).toBe(true);
  });

  it('activity resets the timer and is logged as resumed after an idle period', () => {
    const { anomalies, state } = run([
      { kind: 'activity', ts: 50 * S },
      { kind: 'tick', ts: 100 * S }, // 50 s since activity: nothing
      { kind: 'tick', ts: 110 * S }, // 60 s: inactivity
      { kind: 'activity', ts: 115 * S },
      { kind: 'tick', ts: 175 * S }, // idle again
    ]);
    expect(at(anomalies)).toEqual([110 * S, 175 * S]);
    // The first 'inactivity' (110 s) has aged out of the 60 s rolling log by 175 s.
    expect(state.log.map((e) => e.type)).toEqual(['activity_resumed', 'inactivity']);
  });

  it('logs inactivity then activity_resumed', () => {
    const { state } = run([
      { kind: 'tick', ts: 60 * S },
      { kind: 'activity', ts: 70 * S },
    ]);
    expect(state.log).toEqual([
      { type: 'inactivity', ts: T0 + 60 * S },
      { type: 'activity_resumed', ts: T0 + 70 * S },
    ]);
  });

  it('can raise inactivity alongside the event that revealed it', () => {
    const { anomalies } = run([{ kind: 'copy', ts: 61 * S }]);
    expect(types(anomalies)).toEqual(['inactivity', 'copy_paste']);
  });

  it('uses the policy inactivity threshold', () => {
    const policy = { ...DEFAULT_POLICY, inactivity: { seconds: 5 } };
    const step = stepRuleEngine(createRuleEngineState(0), { kind: 'tick', ts: 5 * S }, policy);
    expect(types(step.anomalies)).toEqual(['inactivity']);
  });
});

describe('browser rule engine: state handling', () => {
  it('never mutates the input state', () => {
    const s0 = createRuleEngineState(T0);
    const frozen = Object.freeze({ ...s0, log: Object.freeze([...s0.log]) });
    const { state } = run([{ kind: 'copy', ts: 1 }], frozen);
    expect(frozen.log).toHaveLength(0);
    expect(state.log).toHaveLength(1);
  });

  it('clamps out-of-order timestamps so time never runs backwards', () => {
    const { state, anomalies } = run([
      { kind: 'copy', ts: 10 * S },
      { kind: 'paste', ts: 5 * S },
    ]);
    expect(at(anomalies)).toEqual([10 * S, 10 * S]);
    expect(state.now).toBe(T0 + 10 * S);
  });

  it('keeps a rolling log of logRetentionSeconds', () => {
    const { state } = run([
      { kind: 'copy', ts: 0 },
      { kind: 'activity', ts: 30 * S },
      { kind: 'paste', ts: 60 * S },
      { kind: 'cut', ts: 61 * S },
    ]);
    // copy at 0 is now 61 s old, beyond the 60 s retention
    expect(state.log.map((e) => e.type)).toEqual(['paste', 'cut']);
  });

  it('survives a JSON round trip (chrome.storage.session) and continues identically', () => {
    const events: RawBrowserEvent[] = [
      { kind: 'fullscreenchange', ts: 0, isFullscreen: true },
      { kind: 'blur', ts: 1 * S },
    ];
    const next: RawBrowserEvent[] = [
      { kind: 'focus', ts: 2 * S },
      { kind: 'fullscreenchange', ts: 3 * S, isFullscreen: false },
    ];
    const { state } = run(events);
    const restored = JSON.parse(JSON.stringify(state)) as RuleEngineState;
    expect(run(next, restored)).toEqual(run(next, state));
  });

  it('rejects unknown event kinds', () => {
    const bogus = { kind: 'keydown', ts: T0 } as unknown as RawBrowserEvent;
    expect(() => stepRuleEngine(createRuleEngineState(T0), bogus, DEFAULT_POLICY)).toThrow(
      /Unknown browser event kind/,
    );
  });
});

describe('browser rule engine: privacy (type + timestamp only)', () => {
  const leaky = {
    url: 'https://exam.example/q/42',
    title: 'Question 42',
    text: 'the secret answer',
    key: 'F5',
    clipboardData: 'pasted text',
  };

  it('the raw event schema strips URLs, text and keys', () => {
    const parsed = RawBrowserEventSchema.parse({ kind: 'paste', ts: 1, ...leaky });
    expect(parsed).toEqual({ kind: 'paste', ts: 1 });
  });

  it('log entries contain only type and ts even if raw events carry extra data', () => {
    const kinds = ['copy', 'cut', 'paste', 'refresh_key', 'beforeunload', 'blur', 'focus'] as const;
    const events = [
      ...kinds.map((kind, i) => ({ kind, ts: i * S, ...leaky })),
      { kind: 'fullscreenchange', ts: 8 * S, isFullscreen: true, ...leaky },
      { kind: 'visibilitychange', ts: 9 * S, hidden: true, ...leaky },
      { kind: 'tick', ts: 100 * S, ...leaky },
      { kind: 'activity', ts: 101 * S, ...leaky },
    ] as RawBrowserEvent[];
    const { state, anomalies } = run(events);

    expect(state.log.length).toBeGreaterThan(0);
    for (const entry of state.log) {
      expect(Object.keys(entry).sort()).toEqual(['ts', 'type']);
      expect(() => BrowserLogEntrySchema.parse(entry)).not.toThrow();
    }
    for (const a of anomalies) expect(Object.keys(a).sort()).toEqual(['confidence', 'ts', 'type']);

    const serialised = JSON.stringify({ state, anomalies });
    for (const value of Object.values(leaky)) expect(serialised).not.toContain(value);
  });
});
