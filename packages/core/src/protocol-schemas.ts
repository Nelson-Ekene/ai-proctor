import { z } from 'zod';
import { PolicySchema } from './policy';
import type { ExternalRequest } from './protocol';

/** Validates messages arriving at the extension from a host page. */
export const ExternalRequestSchema: z.ZodType<ExternalRequest> = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('proctor:start'),
    sessionToken: z.string().min(1).max(4096),
    apiBase: z.url(),
  }),
  z.strictObject({ type: z.literal('proctor:end') }),
  z.strictObject({ type: z.literal('proctor:status') }),
]);

// Extension <-> API contract (session-token authenticated). Implemented by apps/api in Phase 7.

/** GET /v1/session: resolves the bearer session token to its session and policy snapshot. */
export const SessionInfoSchema = z.strictObject({
  sessionId: z.string().min(1),
  policySnapshot: PolicySchema,
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const CONSENT_DECISIONS = ['accepted', 'declined'] as const;

/** POST /v1/sessions/:id/consents */
export const ConsentRecordSchema = z.strictObject({
  decision: z.enum(CONSENT_DECISIONS),
  /** Version of the notice text the candidate was shown. */
  noticeVersion: z.string().min(1),
  ts: z.number().nonnegative(),
});
export type ConsentRecord = z.infer<typeof ConsentRecordSchema>;

/** POST /v1/sessions/:id/end */
export const EndSessionSchema = z.strictObject({ ts: z.number().nonnegative() });
export type EndSession = z.infer<typeof EndSessionSchema>;
