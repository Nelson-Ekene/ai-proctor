import { z } from 'zod';
import type { Policy } from './policy';
import type { DetectedAnomaly } from './schemas';

// Browser rule engine (FR5) as a pure, serialisable state machine. The state is plain data so
// the extension can persist it in chrome.storage.session across service-worker restarts.
// Time comes only from event timestamps (send `tick` events to drive the inactivity timer).

const ts = z.number().nonnegative();

/** Raw input. Unknown fields (URLs, text, keys) are stripped by the schema and never read. */
export const RawBrowserEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fullscreenchange'), ts, isFullscreen: z.boolean() }),
  z.object({ kind: z.literal('visibilitychange'), ts, hidden: z.boolean() }),
  z.object({
    kind: z.enum([
      'blur',
      'focus',
      'copy',
      'cut',
      'paste',
      'beforeunload',
      'refresh_key',
      'activity',
      'tick',
    ]),
    ts,
  }),
]);
export type RawBrowserEvent = z.infer<typeof RawBrowserEventSchema>;

export const BROWSER_LOG_EVENT_TYPES = [
  'fullscreen_enter',
  'fullscreen_exit',
  'visibility_hidden',
  'visibility_visible',
  'window_blur',
  'window_focus',
  'copy',
  'cut',
  'paste',
  'refresh_attempt',
  'inactivity',
  'activity_resumed',
] as const;

/** Rolling log entry: event type and timestamp only, by construction and by schema. */
export const BrowserLogEntrySchema = z.strictObject({
  type: z.enum(BROWSER_LOG_EVENT_TYPES),
  ts,
});
export type BrowserLogEntry = z.infer<typeof BrowserLogEntrySchema>;

export interface RuleEngineState {
  readonly now: number;
  readonly lastActivityTs: number;
  readonly idleFlagged: boolean;
  readonly fullscreen: boolean;
  readonly hidden: boolean;
  readonly blurred: boolean;
  readonly log: readonly BrowserLogEntry[];
}

export interface RuleEngineStep {
  state: RuleEngineState;
  anomalies: DetectedAnomaly[];
}

export function createRuleEngineState(startTs: number): RuleEngineState {
  return {
    now: startTs,
    lastActivityTs: startTs,
    idleFlagged: false,
    fullscreen: false,
    hidden: false,
    blurred: false,
    log: [],
  };
}

/**
 * Feeds one raw event through the rules. Never mutates `state`.
 * Out-of-order timestamps are clamped to the latest time seen so time never runs backwards.
 */
export function stepRuleEngine(
  state: RuleEngineState,
  event: RawBrowserEvent,
  policy: Policy,
): RuleEngineStep {
  const now = Math.max(event.ts, state.now);
  const s = { ...state, now, log: [...state.log] };
  const anomalies: DetectedAnomaly[] = [];
  const log = (type: BrowserLogEntry['type'], at: number) => s.log.push({ type, ts: at });
  const raise = (type: DetectedAnomaly['type'], at: number) =>
    anomalies.push({ type, ts: at, confidence: 1 });

  // Inactivity is evaluated on every event, so a `tick` alone can trigger it. The anomaly is
  // stamped at the moment the threshold was crossed, not when it was noticed.
  const idleMs = policy.inactivity.seconds * 1000;
  if (!s.idleFlagged && now - s.lastActivityTs >= idleMs) {
    const at = s.lastActivityTs + idleMs;
    s.idleFlagged = true;
    log('inactivity', at);
    raise('inactivity', at);
  }

  const wasAway = s.hidden || s.blurred;

  switch (event.kind) {
    case 'fullscreenchange':
      if (event.isFullscreen && !s.fullscreen) {
        s.fullscreen = true;
        log('fullscreen_enter', now);
      } else if (!event.isFullscreen && s.fullscreen) {
        s.fullscreen = false;
        log('fullscreen_exit', now);
        raise('fullscreen_exit', now);
      }
      break;
    case 'visibilitychange':
      if (event.hidden !== s.hidden) {
        s.hidden = event.hidden;
        log(event.hidden ? 'visibility_hidden' : 'visibility_visible', now);
      }
      break;
    case 'blur':
      if (!s.blurred) {
        s.blurred = true;
        log('window_blur', now);
      }
      break;
    case 'focus':
      if (s.blurred) {
        s.blurred = false;
        log('window_focus', now);
      }
      break;
    case 'copy':
    case 'cut':
    case 'paste':
      log(event.kind, now);
      raise('copy_paste', now);
      break;
    case 'beforeunload':
    case 'refresh_key':
      log('refresh_attempt', now);
      raise('refresh_attempt', now);
      break;
    case 'activity':
      if (s.idleFlagged) log('activity_resumed', now);
      s.idleFlagged = false;
      s.lastActivityTs = now;
      break;
    case 'tick':
      break;
    default:
      throw new TypeError('Unknown browser event kind');
  }

  // A tab switch typically fires both visibilitychange and blur: raise once per departure.
  if (!wasAway && (s.hidden || s.blurred)) raise('tab_switch_or_blur', now);

  const cutoff = now - policy.capture.logRetentionSeconds * 1000;
  s.log = s.log.filter((e) => e.ts >= cutoff);

  return { state: s, anomalies };
}
