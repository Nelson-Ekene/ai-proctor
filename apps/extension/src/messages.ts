import { RawBrowserEventSchema, type Policy, type SdkEventMessage } from '@proctor/core';
import { z } from 'zod';

// Messages inside the extension (pages, offscreen document, content script <-> service worker).

/** Version of the consent notice text; bump when the wording changes. */
export const NOTICE_VERSION = 'consent-notice-v1';

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
