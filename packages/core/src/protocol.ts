// SDK <-> extension protocol: constants and types only (no zod), so the host-page SDK can
// import from @proctor/core without bundling zod. Runtime schemas live in protocol-schemas.ts.

/** `source` field on window messages relayed from the extension's content script to the SDK. */
export const PROCTOR_EVENT_SOURCE = 'proctor-extension';

export const SDK_EVENTS = ['ready', 'consent_declined', 'ended'] as const;
export type SdkEventName = (typeof SDK_EVENTS)[number];

export interface SdkEventMessage {
  source: typeof PROCTOR_EVENT_SOURCE;
  event: SdkEventName;
  sessionId: string;
}

export type ExternalRequest =
  | { type: 'proctor:start'; sessionToken: string; apiBase: string }
  | { type: 'proctor:end' }
  | { type: 'proctor:status' };

export const EXTERNAL_ERROR_CODES = [
  'invalid_request',
  'origin_not_allowed',
  'api_not_allowed',
  'session_in_progress',
  'session_fetch_failed',
  'no_session',
  'internal_error',
] as const;
export type ExternalErrorCode = (typeof EXTERNAL_ERROR_CODES)[number];

export type ExternalResponse =
  { ok: true; sessionId?: string; status?: string } | { ok: false; error: ExternalErrorCode };
