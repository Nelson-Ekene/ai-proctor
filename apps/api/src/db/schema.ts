import {
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { EvidenceRef, Policy } from '@proctor/core';

// Database schema (BUILD_PLAN 5.4). Advisory only: there is deliberately no column that
// records a pass, fail or any other verdict; sessions carry a risk score and a band.

export const roleEnum = pgEnum('role', ['admin', 'reviewer']);
export const sessionStatusEnum = pgEnum('session_status', ['created', 'active', 'ended']);
export const evidenceKindEnum = pgEnum('evidence_kind', ['frame', 'audio', 'event_sequence']);
export const consentDecisionEnum = pgEnum('consent_decision', ['accepted', 'declined']);
export const actorTypeEnum = pgEnum('actor_type', ['user', 'api_key', 'session', 'system']);

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
/** Epoch milliseconds from the device (anomaly/evidence/consent times). */
const epochMs = (name: string) => bigint(name, { mode: 'number' });

export const organisations = pgTable('organisations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  label: text('label').notNull(),
  /** SHA-256 of the secret; the secret itself is shown once and never stored. */
  keyHash: text('key_hash').notNull().unique(),
  createdAt: ts('created_at').notNull().defaultNow(),
  revokedAt: ts('revoked_at'),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  email: text('email').notNull().unique(),
  /** scrypt$N$r$p$salt$hash */
  passwordHash: text('password_hash').notNull(),
  role: roleEnum('role').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const userSessions = pgTable('user_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const exams = pgTable('exams', {
  id: uuid('id').primaryKey().defaultRandom(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  name: text('name').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/**
 * Versioned policies: an organisation default (examId null) with optional per-exam overrides.
 * Rows are never updated. A null `policy` on an exam version means "override removed: inherit
 * the organisation default".
 */
export const policies = pgTable(
  'policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    examId: uuid('exam_id').references(() => exams.id),
    version: integer('version').notNull(),
    policy: jsonb('policy').$type<Policy>(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('policies_scope_version').on(t.organisationId, t.examId, t.version).nullsNotDistinct(),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    examId: uuid('exam_id').references(() => exams.id),
    /** The integrator's reference for the candidate (no identity data is collected). */
    candidateRef: text('candidate_ref').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    tokenExpiresAt: ts('token_expires_at').notNull(),
    /** Exact policy in force for this session: every score is reproducible from it. */
    policySnapshot: jsonb('policy_snapshot').$type<Policy>().notNull(),
    policyVersionId: uuid('policy_version_id').references(() => policies.id),
    status: sessionStatusEnum('status').notNull().default('created'),
    startedAt: ts('started_at').notNull().defaultNow(),
    endedAt: ts('ended_at'),
    risk: doublePrecision('risk').notNull().default(0),
    band: text('band').notNull().default('low'),
  },
  (t) => [index('sessions_org_risk').on(t.organisationId, t.risk)],
);

// Client-generated ids (anomaly, evidence, idempotency key) are scoped to their session in every
// key, so one session can never collide with, or claim, another session's records.

/** Raw anomalies as uploaded (id = client id = idempotency key). Violations derive from these. */
export const anomalies = pgTable(
  'anomalies',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    type: text('type').notNull(),
    ts: epochMs('ts').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    evidence: jsonb('evidence').$type<EvidenceRef[]>().notNull(),
    receivedAt: ts('received_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.id] })],
);

/**
 * Merged violations, recomputed from all anomalies of the session on every ingest. Each row
 * carries its evidence refs, so the score is reproducible from these rows + the policy snapshot.
 */
export const violations = pgTable(
  'violations',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    type: text('type').notNull(),
    category: text('category').notNull(),
    severity: text('severity').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    firstTs: epochMs('first_ts').notNull(),
    lastTs: epochMs('last_ts').notNull(),
    count: integer('count').notNull(),
    anomalyIds: jsonb('anomaly_ids').$type<string[]>().notNull(),
    evidence: jsonb('evidence').$type<EvidenceRef[]>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.id] })],
);

/** Evidence manifest (from anomaly records) and upload state. */
export const evidence = pgTable(
  'evidence',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    kind: evidenceKindEnum('kind').notNull(),
    ts: epochMs('ts').notNull(),
    /** Random object key (not derived from ids); null until uploaded. */
    storageKey: text('storage_key'),
    contentType: text('content_type'),
    bytes: integer('bytes'),
    uploadedAt: ts('uploaded_at'),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.id] })],
);

export const consents = pgTable('consents', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  decision: consentDecisionEnum('decision').notNull(),
  noticeVersion: text('notice_version').notNull(),
  ts: epochMs('ts').notNull(),
  receivedAt: ts('received_at').notNull().defaultNow(),
});

/** Idempotency keys of processed session requests (consent, end), so retries count once. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.key] })],
);

/** Append-only audit trail (FR14). Survives retention deletion of the data it refers to. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: uuid('organisation_id'),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    details: jsonb('details').$type<Record<string, unknown>>(),
    ts: ts('ts').notNull().defaultNow(),
  },
  (t) => [index('audit_org_ts').on(t.organisationId, t.ts)],
);
