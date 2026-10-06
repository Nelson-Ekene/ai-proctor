import { describe, expect, it } from 'vitest';
import { buildCaptureWindow, captureWindowClosesAt } from './capture';
import { DEFAULT_POLICY, parsePolicy } from './policy';
import { createRuleEngineState, stepRuleEngine, type BrowserLogEntry } from './rules';

const S = 1000;

describe('buildCaptureWindow', () => {
  const T = 100 * S;
  const log: BrowserLogEntry[] = [
    { type: 'copy', ts: T - 31 * S }, // too early
    { type: 'window_blur', ts: T - 30 * S }, // inclusive start
    { type: 'paste', ts: T },
    { type: 'window_focus', ts: T + 15 * S }, // inclusive end
    { type: 'cut', ts: T + 15 * S + 1 }, // too late
  ];

  it('returns events from -30 s to +15 s inclusive', () => {
    const w = buildCaptureWindow(T, log, DEFAULT_POLICY);
    expect(w.from).toBe(T - 30 * S);
    expect(w.to).toBe(T + 15 * S);
    expect(w.events.map((e) => e.type)).toEqual(['window_blur', 'paste', 'window_focus']);
  });

  it('sorts events and copies only type and ts', () => {
    const messy = [
      { type: 'paste', ts: T + 2, extra: 'x' },
      { type: 'copy', ts: T + 1 },
    ] as BrowserLogEntry[];
    const w = buildCaptureWindow(T, messy, DEFAULT_POLICY);
    expect(w.events).toEqual([
      { type: 'copy', ts: T + 1 },
      { type: 'paste', ts: T + 2 },
    ]);
  });

  it('follows the policy window sizes', () => {
    const policy = parsePolicy({
      ...DEFAULT_POLICY,
      capture: { ...DEFAULT_POLICY.capture, eventsBeforeSeconds: 5, eventsAfterSeconds: 5 },
    });
    const w = buildCaptureWindow(T, log, policy);
    expect(w.events.map((e) => e.type)).toEqual(['paste']);
    expect(captureWindowClosesAt(T, policy)).toBe(T + 5 * S);
  });

  it('reports when the window is complete', () => {
    expect(captureWindowClosesAt(T, DEFAULT_POLICY)).toBe(T + 15 * S);
  });

  it('works on the rule engine log: retention covers the whole window', () => {
    let state = createRuleEngineState(0);
    const feed = (e: Parameters<typeof stepRuleEngine>[1]) => {
      state = stepRuleEngine(state, e, DEFAULT_POLICY).state;
    };
    feed({ kind: 'blur', ts: 10 * S });
    feed({ kind: 'focus', ts: 20 * S });
    feed({ kind: 'activity', ts: 39 * S });
    feed({ kind: 'paste', ts: 40 * S }); // the anomaly
    feed({ kind: 'copy', ts: 50 * S });
    feed({ kind: 'tick', ts: captureWindowClosesAt(40 * S, DEFAULT_POLICY) }); // window closes

    const w = buildCaptureWindow(40 * S, state.log, DEFAULT_POLICY);
    expect(w.events.map((e) => e.type)).toEqual(['window_blur', 'window_focus', 'paste', 'copy']);
  });
});
