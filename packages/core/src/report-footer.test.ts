import { describe, expect, it } from 'vitest';
import { REPORT_LIMITATIONS } from './report-footer';

describe('report footer limitations', () => {
  it('documents the dragged-tab and second-device limitations', () => {
    expect(REPORT_LIMITATIONS.some((l) => /dragged into another browser window/.test(l))).toBe(
      true,
    );
    expect(REPORT_LIMITATIONS.some((l) => /second device or screen/i.test(l))).toBe(true);
  });

  it('documents the face-matching limits (phase 11)', () => {
    expect(REPORT_LIMITATIONS.some((l) => /face matching .* reference frame/i.test(l))).toBe(true);
  });

  it('is frozen and uses advisory wording only', () => {
    expect(Object.isFrozen(REPORT_LIMITATIONS)).toBe(true);
    expect(REPORT_LIMITATIONS.join(' ')).not.toMatch(/\bpass|\bfail|disqualif|cheat|guilty/i);
  });
});
