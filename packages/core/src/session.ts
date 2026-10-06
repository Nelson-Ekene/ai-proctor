import { z } from 'zod';
import { PolicySchema } from './policy';

// Session lifecycle on the candidate's device. Pure reducer: the extension persists the state
// and performs side effects; this module only decides what is allowed.
//
//   awaiting_consent --accept--> setup --setup_completed--> active --end--> ended
//          \--decline--> consent_declined
//   (end is also accepted from awaiting_consent and setup)
//
// There is deliberately no state that judges the candidate or stops the exam.

export const SESSION_STATUSES = [
  'awaiting_consent',
  'consent_declined',
  'setup',
  'active',
  'ended',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SessionStateSchema = z.strictObject({
  status: z.enum(SESSION_STATUSES),
  sessionId: z.string().min(1),
  /** Short-lived session token. Kept in memory-backed storage only. */
  sessionToken: z.string().min(1),
  apiBase: z.string().min(1),
  examTabId: z.number().int(),
  policy: PolicySchema,
  startedAt: z.number().nonnegative(),
  consentAt: z.number().nonnegative().optional(),
  activeAt: z.number().nonnegative().optional(),
  endedAt: z.number().nonnegative().optional(),
  /** True only while the camera/microphone stream is actually open. Drives the indicator. */
  mediaOn: z.boolean(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

export type SessionEvent =
  | { type: 'consent_accepted'; ts: number }
  | { type: 'consent_declined'; ts: number }
  | { type: 'setup_completed'; ts: number }
  | { type: 'media_changed'; on: boolean }
  | { type: 'end'; ts: number };

export function isTerminal(status: SessionStatus): boolean {
  return status === 'consent_declined' || status === 'ended';
}

/** Camera/mic may be opened only after consent (setup preview) and during the session. */
export function mediaAllowed(status: SessionStatus): boolean {
  return status === 'setup' || status === 'active';
}

/** Background capture (offscreen document) runs only in the active state. */
export function captureAllowed(status: SessionStatus): boolean {
  return status === 'active';
}

/**
 * Applies an event. Events that are not valid in the current state return the same object,
 * so callers can detect a no-op with `next === state`.
 */
export function transition(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case 'consent_accepted':
      return state.status === 'awaiting_consent'
        ? { ...state, status: 'setup', consentAt: event.ts }
        : state;
    case 'consent_declined':
      return state.status === 'awaiting_consent'
        ? { ...state, status: 'consent_declined', endedAt: event.ts }
        : state;
    case 'setup_completed':
      return state.status === 'setup' ? { ...state, status: 'active', activeAt: event.ts } : state;
    case 'media_changed':
      if (event.on && !captureAllowed(state.status)) return state;
      return state.mediaOn === event.on ? state : { ...state, mediaOn: event.on };
    case 'end':
      return isTerminal(state.status)
        ? state
        : { ...state, status: 'ended', endedAt: event.ts, mediaOn: false };
  }
}
