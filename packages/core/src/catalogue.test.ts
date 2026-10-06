import { describe, expect, it } from 'vitest';
import { VIOLATION_CATALOGUE, VIOLATION_TYPES, categoryOf } from './catalogue';
import { DEFAULT_POLICY } from './policy';

describe('violation catalogue', () => {
  it('lists the 12 PRD violation types', () => {
    expect(VIOLATION_TYPES).toHaveLength(12);
    expect(Object.keys(VIOLATION_CATALOGUE).sort()).toEqual([...VIOLATION_TYPES].sort());
  });

  it.each([
    ['fullscreen_exit', 'browser', 'medium'],
    ['tab_switch_or_blur', 'browser', 'medium'],
    ['copy_paste', 'browser', 'low'],
    ['refresh_attempt', 'browser', 'low'],
    ['inactivity', 'browser', 'low'],
    ['no_face', 'video', 'medium'],
    ['multiple_faces', 'video', 'high'],
    ['phone_detected', 'video', 'high'],
    ['book_or_notes', 'video', 'medium'],
    ['gaze_away_sustained', 'video', 'low'],
    ['speech_detected', 'audio', 'medium'],
    ['multiple_voices', 'audio', 'high'],
  ] as const)('%s is %s with default severity %s', (type, category, severity) => {
    expect(categoryOf(type)).toBe(category);
    expect(DEFAULT_POLICY.severityByType[type]).toBe(severity);
  });

  it('marks browser rules deterministic and video/audio as model-scored', () => {
    for (const type of VIOLATION_TYPES) {
      const { category, confidenceSource } = VIOLATION_CATALOGUE[type];
      expect(confidenceSource).toBe(category === 'browser' ? 'deterministic' : 'model');
    }
  });
});
