import { computeRisk, DEFAULT_POLICY, type Policy } from '@proctor/core';
import { describe, expect, it } from 'vitest';
import { prdReport } from '../test/fixtures';
import { offset, points, relative, score } from './format';
import { checkForm, fromForm, toForm, weightSum } from './policy-form';
import { scoreImpact, toCoreViolations } from './preview';
import { parseRoute } from './router';

describe('policy form', () => {
  it('round-trips the default policy exactly', () => {
    const form = toForm(DEFAULT_POLICY);
    expect(form.weights).toEqual({ browser: 40, video: 40, audio: 20 });
    expect(fromForm(DEFAULT_POLICY, form)).toEqual(DEFAULT_POLICY);
    expect(checkForm(DEFAULT_POLICY, form)).toEqual({ ok: true, policy: DEFAULT_POLICY });
  });

  it('round-trips awkward percentages without float noise', () => {
    const p: Policy = { ...DEFAULT_POLICY, weights: { browser: 0.07, video: 0.58, audio: 0.35 } };
    const form = toForm(p);
    expect(form.weights).toEqual({ browser: 7, video: 58, audio: 35 });
    expect(weightSum(form)).toBe(100);
    expect(checkForm(p, form).ok).toBe(true);
  });

  it('enforces weights summing to 100, reported once in percent', () => {
    const form = toForm(DEFAULT_POLICY);
    form.weights.browser = 50;
    const check = checkForm(DEFAULT_POLICY, form);
    expect(check).toEqual({ ok: false, problems: ['Weights must add up to 100 (now 110).'] });
  });

  it('reports other invalid values from the core schema', () => {
    const form = toForm(DEFAULT_POLICY);
    form.bands = { lowMax: 70, mediumMax: 50 };
    form.retentionDays = Number.NaN;
    const check = checkForm(DEFAULT_POLICY, form);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.problems.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps fields the form does not edit', () => {
    const form = toForm(DEFAULT_POLICY);
    form.retentionDays = 7;
    const p = fromForm(DEFAULT_POLICY, form);
    expect(p.upload).toEqual(DEFAULT_POLICY.upload);
    expect(p.setupCheck).toEqual(DEFAULT_POLICY.setupCheck);
    expect(p.retentionDays).toBe(7);
  });
});

describe('score preview', () => {
  it('equals core scoring of the same violations', () => {
    const report = prdReport();
    const core = toCoreViolations(report.violations);
    expect(computeRisk(core, DEFAULT_POLICY).risk).toBe(49);
    const draft: Policy = { ...DEFAULT_POLICY, weights: { browser: 0.2, video: 0.6, audio: 0.2 } };
    const impact = scoreImpact(report.violations, DEFAULT_POLICY, draft);
    expect(impact.current.risk).toBe(49);
    // 0.2 x 50 + 0.6 x 60 + 0.2 x 25 = 51
    expect(impact.preview.risk).toBe(51);
    expect(impact.delta).toBe(2);
  });
});

describe('format', () => {
  it('formats scores, points and offsets', () => {
    expect(score(49)).toBe('49.0');
    expect(points(13.5)).toBe('13.5');
    expect(points(9.999999)).toBe('10');
    expect(offset(65_000, 0)).toBe('+01:05');
    expect(offset(3_725_000, 0)).toBe('+1:02:05');
    expect(relative(-4000, 0)).toBe('-4.0 s');
    expect(relative(0, 0)).toBe('0 s');
    expect(relative(9000, 0)).toBe('+9.0 s');
  });
});

describe('router', () => {
  it('parses the dashboard routes', () => {
    expect(parseRoute('/')).toEqual({ name: 'sessions' });
    expect(parseRoute('/sessions/abc')).toEqual({ name: 'report', sessionId: 'abc' });
    expect(parseRoute('/policy')).toEqual({ name: 'policy' });
    expect(parseRoute('/nope')).toEqual({ name: 'notFound' });
  });
});
