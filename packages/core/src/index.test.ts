import { describe, expect, it } from 'vitest';
import * as core from './index';

describe('@proctor/core public API', () => {
  it('exposes the phase 1 building blocks', () => {
    expect(core.DEFAULT_POLICY).toBeDefined();
    for (const fn of [
      core.parsePolicy,
      core.sampleFrameTimes,
      core.mergeViolations,
      core.computeRisk,
      core.combineCategoryPoints,
      core.createRuleEngineState,
      core.stepRuleEngine,
      core.buildCaptureWindow,
      core.captureWindowClosesAt,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });
});
