import { describe, expect, it } from 'vitest';
import { CATEGORIES, SEVERITIES, VIOLATION_TYPES } from './catalogue';
import {
  BAND_LABELS,
  CATEGORY_LABELS,
  FLAGGED_FOR_REVIEW,
  SEVERITY_LABELS,
  VIOLATION_LABELS,
} from './labels';
import { RISK_BANDS } from './schemas';

const VERDICT = /\b(cheat\w*|fail\w*|guilty|pass(ed)?|disqualif\w*|block(ed)?)\b/i;

describe('reviewer labels', () => {
  it('cover every type, band, category and severity', () => {
    expect(Object.keys(VIOLATION_LABELS).sort()).toEqual([...VIOLATION_TYPES].sort());
    expect(Object.keys(BAND_LABELS)).toEqual([...RISK_BANDS]);
    expect(Object.keys(CATEGORY_LABELS)).toEqual([...CATEGORIES]);
    expect(Object.keys(SEVERITY_LABELS)).toEqual([...SEVERITIES]);
  });

  it('bands read only "Low / Medium / High risk"', () => {
    expect(Object.values(BAND_LABELS)).toEqual(['Low risk', 'Medium risk', 'High risk']);
  });

  it('use no verdict words', () => {
    const all = [
      ...Object.values(VIOLATION_LABELS),
      ...Object.values(BAND_LABELS),
      ...Object.values(CATEGORY_LABELS),
      ...Object.values(SEVERITY_LABELS),
      FLAGGED_FOR_REVIEW,
    ];
    for (const label of all) expect(label).not.toMatch(VERDICT);
  });
});
