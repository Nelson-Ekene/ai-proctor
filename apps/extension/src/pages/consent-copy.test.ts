import { DEFAULT_POLICY, parsePolicy } from '@proctor/core';
import { describe, expect, it } from 'vitest';
import { buildConsentNotice, noticeText } from './consent-copy';

describe('consent notice', () => {
  it('states what, why and how long using the policy values', () => {
    const text = noticeText(buildConsentNotice(DEFAULT_POLICY));
    expect(text).toContain('5 still photos at random moments in every 30 seconds');
    expect(text).toContain('3 extra photos');
    expect(text).toContain('at most 30 seconds');
    expect(text).toContain('kept for 30 days');
    expect(text).toMatch(/Why/);
    expect(text).toMatch(/No face recognition/);
  });

  it('follows a different policy, including singular forms', () => {
    const policy = parsePolicy({
      ...DEFAULT_POLICY,
      sampling: { framesPerWindow: 1, windowSeconds: 60 },
      capture: { ...DEFAULT_POLICY.capture, burstFrames: 1 },
      retentionDays: 1,
    });
    const text = noticeText(buildConsentNotice(policy));
    expect(text).toContain('1 still photo at random moments in every 60 seconds');
    expect(text).toContain('1 extra photo taken');
    expect(text).toContain('kept for 1 day and');
  });

  it('never uses verdict language', () => {
    const text = noticeText(buildConsentNotice(DEFAULT_POLICY));
    expect(text).not.toMatch(/\bpass|\bfail|disqualif|\bblock|cheat|guilty/i);
  });
});
