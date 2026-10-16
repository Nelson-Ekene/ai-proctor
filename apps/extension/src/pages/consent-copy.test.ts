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
    for (const policy of [DEFAULT_POLICY, faceMatchPolicy]) {
      const text = noticeText(buildConsentNotice(policy));
      expect(text).not.toMatch(/\bpass|\bfail|disqualif|\bblock|cheat|guilty/i);
    }
  });
});

const faceMatchPolicy = parsePolicy({
  ...DEFAULT_POLICY,
  faceMatch: { ...DEFAULT_POLICY.faceMatch, enabled: true },
});

describe('consent notice with optional face matching (phase 11)', () => {
  it('is not offered when the policy does not enable it', () => {
    expect(buildConsentNotice(DEFAULT_POLICY).faceMatch).toBeUndefined();
  });

  it('explains face matching in its own section with its own opt-in', () => {
    const notice = buildConsentNotice(faceMatchPolicy);
    const section = [notice.faceMatch?.heading, ...(notice.faceMatch?.items ?? [])].join('\n');
    expect(section).toMatch(/biometric data/);
    expect(section).toMatch(/never uploaded or saved/);
    expect(section).toMatch(/3 photos in a row/);
    expect(section).toMatch(/your choice/i);
    expect(notice.faceMatch?.optInLabel).toMatch(/optional face matching/);
    // The main agreement does not include face matching.
    expect(notice.agreeLabel).toMatch(/except face matching/);
  });

  it('no longer claims there is no biometric template', () => {
    const text = noticeText(buildConsentNotice(faceMatchPolicy));
    expect(text).not.toMatch(/No face recognition, identity checks or biometric templates/);
    expect(text).toMatch(/No face template is ever uploaded or saved/);
    expect(text).toContain(buildConsentNotice(faceMatchPolicy).faceMatch?.optInLabel);
  });
});
