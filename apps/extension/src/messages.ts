import {
  PendingAnomalySchema,
  RawBrowserEventSchema,
  type Policy,
  type SdkEventMessage,
} from '@proctor/core';
import { z } from 'zod';

/** Video sampling state recorded on the session (slow-device degradation, Phase 4). */
export const VideoMetaSchema = z.strictObject({
  degraded: z.boolean(),
  framesPerWindow: z.number().int().positive(),
  medianInferenceMs: z.number().nonnegative().optional(),
  /** Face-matching progress (Phase 11); absent when face matching is off for the session. */
  faceMatch: z.enum(['enrolling', 'enrolled']).optional(),
});
export type VideoMetaRecord = z.infer<typeof VideoMetaSchema>;

/** Microphone monitoring state recorded on the session (Phase 5). */
export const AudioMetaSchema = z.strictObject({
  /** True once the voice-activity model is analysing live microphone frames. */
  listening: z.boolean(),
  /** Identifies the multiple-voice implementation used (it is a low-confidence heuristic). */
  multiVoiceMethod: z.string().min(1),
});
export type AudioMetaRecord = z.infer<typeof AudioMetaSchema>;

// Messages inside the extension (pages, offscreen document, content script <-> service worker).

/** Version of the consent notice text; bump when the wording changes. */
export const NOTICE_VERSION = 'consent-notice-v1';
/** Recorded instead when the candidate also opted in to face matching (Phase 11). */
export { FACE_MATCH_NOTICE_VERSION } from '@proctor/core';

export const CHECK_STATUSES = ['ready', 'needs_attention'] as const;
export const CheckStatusSchema = z.enum(CHECK_STATUSES);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const SetupResultSchema = z.strictObject({
  face: CheckStatusSchema,
  mic: CheckStatusSchema,
  performance: CheckStatusSchema,
});
export type SetupResult = z.infer<typeof SetupResultSchema>;

export const InternalRequestSchema = z.discriminatedUnion('type', [
  // consent page
  z.strictObject({ type: z.literal('consent:get') }),
  z.strictObject({
    type: z.literal('consent:decide'),
    accepted: z.boolean(),
    noticeVersion: z.string().min(1),
  }),
  // setup page
  z.strictObject({ type: z.literal('setup:get') }),
  z.strictObject({ type: z.literal('setup:complete'), result: SetupResultSchema }),
  // offscreen document
  z.strictObject({ type: z.literal('media:state'), on: z.boolean() }),
  z.strictObject({ type: z.literal('video:config') }),
  z.strictObject({
    type: z.literal('video:anomalies'),
    anomalies: z.array(PendingAnomalySchema).min(1),
  }),
  z.strictObject({ type: z.literal('video:meta'), meta: VideoMetaSchema }),
  z.strictObject({
    type: z.literal('audio:anomalies'),
    anomalies: z.array(PendingAnomalySchema).min(1),
  }),
  z.strictObject({ type: z.literal('audio:meta'), meta: AudioMetaSchema }),
  // Diagnostics from the offscreen document (its console is not visible to tests).
  z.strictObject({ type: z.literal('diag'), message: z.string().max(500) }),
  // content script
  z.strictObject({ type: z.literal('content:get') }),
  // Raw browser event for the rule engine. The event schema strips any field other than
  // kind/ts (and hidden/isFullscreen), so URLs, text or keys can never reach the log.
  z.strictObject({ type: z.literal('rules:event'), event: RawBrowserEventSchema }),
]);
export type InternalRequest = z.infer<typeof InternalRequestSchema>;

export type InternalError =
  | 'invalid_request'
  | 'not_allowed'
  | 'wrong_state'
  | 'api_error'
  | 'capture_failed'
  | 'internal_error';

export type InternalResponse =
  | {
      ok: true;
      policy?: Policy;
      /** video:config: session the evidence belongs to. */
      sessionId?: string;
      /** video:config: face matching enabled by the policy and opted in to by the candidate. */
      faceMatch?: boolean;
      /** content:get: recording indicator on for this tab. */
      on?: boolean;
      /** content:get: browser monitoring active for this tab, with its ping interval. */
      monitorPingMs?: number;
    }
  | { ok: false; error: InternalError };

/** Service worker -> content script. */
export type ContentMessage =
  | { type: 'indicator'; on: boolean }
  | { type: 'sdk-event'; message: SdkEventMessage }
  /** Start (pingMs) or stop (null) browser monitoring. */
  | { type: 'monitor'; pingMs: number | null };
