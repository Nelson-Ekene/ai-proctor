import type {
  CategoryResult,
  EventSequence,
  EvidenceRef,
  FaceMatchStatus,
  Policy,
  RiskBand,
  Violation,
} from '@proctor/core';

// Response shapes of the reviewer/admin API (apps/api/src/routes/dashboard.ts, report.ts).

export type Role = 'admin' | 'reviewer';
export type SessionStatus = 'created' | 'active' | 'ended';

export interface LoginResponse {
  token: string;
  expiresAt: string;
  role: Role;
}

export interface Me {
  id: string;
  email: string;
  role: Role;
  organisationId: string;
}

export interface SessionSummary {
  id: string;
  examId: string | null;
  candidateRef: string;
  status: SessionStatus;
  startedAt: string;
  endedAt: string | null;
  risk: number;
  band: RiskBand;
  violationCount: number;
}

export interface SessionList {
  sessions: SessionSummary[];
  total: number;
}

export interface ReportEvidence extends EvidenceRef {
  uploaded: boolean;
}

export interface ReportViolation extends Omit<Violation, 'evidence'> {
  label: string;
  points: number;
  evidence: ReportEvidence[];
}

export interface SessionReport {
  session: {
    id: string;
    examId: string | null;
    candidateRef: string;
    status: SessionStatus;
    startedAt: string;
    endedAt: string | null;
    policyVersionId: string | null;
  };
  risk: number;
  band: RiskBand;
  categories: CategoryResult[];
  violations: ReportViolation[];
  policySnapshot: Policy;
  /** Optional face matching (Phase 11); absent in reports from older API versions. */
  faceMatch?: FaceMatchStatus;
  reproducible: boolean;
  limitations: string[];
  generatedAt: string;
}

export interface EvidenceUrl {
  url: string;
  expiresAt: string;
  kind: EvidenceRef['kind'];
  contentType: string | null;
}

export type { EventSequence };

export interface Exam {
  id: string;
  name: string;
  createdAt: string;
}

export interface PolicyVersion {
  id: string;
  version: number;
  policy: Policy | null;
  createdBy: string | null;
  createdAt: string;
}

export interface Organisation {
  id: string;
  name: string;
  region: 'eu' | 'uk' | 'us' | 'other';
  regionConfig: { label: string; maxRetentionDays: number; consentNoticeVersions: string[] };
}

export interface Metrics {
  since: string | null;
  sessions: number;
  violations: { total: number; withEvidence: number; evidenceLinkedRate: number | null };
  evidence: { referenced: number; uploaded: number; uploadedRate: number | null };
  setupCheck: {
    consented: number;
    completed: number;
    completionRate: number | null;
    allReady: number;
  };
  reviewerTime: {
    reviewedSessions: number;
    medianMs: number | null;
    p90Ms: number | null;
    meanMs: number | null;
  };
}

export interface AuditEntry {
  id: string;
  actorType: 'user' | 'api_key' | 'session' | 'system';
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  ts: string;
}

export interface PolicyView {
  examId: string | null;
  effective: {
    policy: Policy;
    versionId: string | null;
    version: number | null;
    source: 'exam' | 'organisation' | 'default';
  };
  versions: PolicyVersion[];
}
