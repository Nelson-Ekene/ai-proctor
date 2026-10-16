import { FACE_MATCH_NOTICE_VERSION } from '@proctor/core';

// Data-protection region configuration (BUILD_PLAN Phase 9.4, PRD open question on regions).
// Each organisation has a region. The region caps how long session data may be kept (whatever
// the policy says) and lists the consent notice versions that are valid there; a consent record
// for any other notice is refused, so capture cannot start under the wrong notice.
//
// ASSUMPTION: the values below are defaults for the pilot, to be confirmed by legal review per
// deployment. They are configuration, not product logic: change them here (or per deployment).

export const REGIONS = ['eu', 'uk', 'us', 'other'] as const;
export type Region = (typeof REGIONS)[number];

export interface RegionConfig {
  label: string;
  /** Upper bound for policy.retentionDays; retention never keeps data longer than this. */
  maxRetentionDays: number;
  /** Consent notice versions candidates in this region may be shown (extension NOTICE_VERSION). */
  consentNoticeVersions: readonly string[];
}

/**
 * Notice versions: the standard notice, and the standard notice plus the separate opt-in to
 * on-device face matching (Phase 11, only offered when the policy enables it).
 * ASSUMPTION: face matching is accepted in every region because it is opt-in per candidate and
 * off by default per organisation. Biometric processing needs its own legal review (e.g. a DPIA
 * under GDPR Art. 9, BIPA in Illinois) before an organisation turns it on; drop the version from
 * a region to refuse it there.
 */
const NOTICES = ['consent-notice-v1', FACE_MATCH_NOTICE_VERSION] as const;

export const REGION_CONFIG: Readonly<Record<Region, RegionConfig>> = Object.freeze({
  eu: { label: 'European Union (GDPR)', maxRetentionDays: 30, consentNoticeVersions: NOTICES },
  uk: { label: 'United Kingdom (UK GDPR)', maxRetentionDays: 30, consentNoticeVersions: NOTICES },
  us: { label: 'United States', maxRetentionDays: 90, consentNoticeVersions: NOTICES },
  other: { label: 'Other', maxRetentionDays: 90, consentNoticeVersions: NOTICES },
});

/** Days a session is kept: its policy snapshot's retentionDays, capped by the region. */
export function effectiveRetentionDays(region: Region, policyRetentionDays: number): number {
  return Math.min(policyRetentionDays, REGION_CONFIG[region].maxRetentionDays);
}
