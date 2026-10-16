import type { Severity } from './catalogue';
import type { Policy } from './policy';

// Evidence upload queue rules (FR12, BUILD_PLAN Phase 6). Pure: the extension persists the
// items (IndexedDB) and performs the requests; this module decides order, retry timing,
// eviction and expiry.
//
// - Every item has a stable id that is sent as the Idempotency-Key, so a retry after a lost
//   response can never double-count anything on the server.
// - Evidence depends on its anomaly record: the record is sent first.
// - Anomalies and their evidence form a group that is evicted as a whole, so no anomaly can
//   reach the server without its evidence.

export const QUEUE_KINDS = ['consent', 'setup', 'end', 'anomaly', 'evidence'] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

export interface QueueItemMeta {
  /** Stable idempotency key. */
  id: string;
  sessionId: string;
  kind: QueueKind;
  /** Higher is sent first. */
  priority: number;
  /** Id of an item that must be acknowledged before this one is sent. */
  dependsOn?: string;
  /** Eviction unit (the anomaly id for an anomaly and its evidence). */
  group?: string;
  bytes: number;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  expiresAt: number;
}

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

/**
 * The consent decision goes first; anomaly groups follow by severity, so the most significant
 * evidence reaches the reviewer first; the end record goes last, so its arrival means
 * everything queued before it has been sent.
 */
export function priorityFor(kind: QueueKind, severity?: Severity): number {
  if (kind === 'consent') return 100;
  if (kind === 'setup') return 90;
  if (kind === 'end') return 1;
  return 10 + (severity ? SEVERITY_RANK[severity] : 0);
}

/** Exponential backoff with "equal jitter": between half and the full capped delay. */
export function backoffMs(
  attempts: number,
  policy: Pick<Policy, 'upload'>,
  rng: () => number,
): number {
  const { retryBaseMs, retryMaxMs } = policy.upload;
  const capped = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, attempts - 1));
  return capped / 2 + rng() * (capped / 2);
}

function compare(a: QueueItemMeta, b: QueueItemMeta): number {
  return b.priority - a.priority || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);
}

/** The next item to send at `now`, if any: due, dependency acknowledged, best priority. */
export function nextDue<T extends QueueItemMeta>(items: readonly T[], now: number): T | undefined {
  const pending = new Set(items.map((i) => i.id));
  return items
    .filter(
      (i) => i.nextAttemptAt <= now && (i.dependsOn === undefined || !pending.has(i.dependsOn)),
    )
    .sort(compare)[0];
}

/** Earliest time any item becomes due (to schedule the next drain), or undefined if empty. */
export function nextWakeAt(items: readonly QueueItemMeta[]): number | undefined {
  return items.length === 0 ? undefined : Math.min(...items.map((i) => i.nextAttemptAt));
}

export function expiredItems<T extends QueueItemMeta>(items: readonly T[], now: number): T[] {
  return items.filter((i) => i.expiresAt <= now);
}

export interface EvictionResult<T> {
  /** Items to delete to make room. */
  evict: T[];
  /** False when the incoming items cannot fit even after evicting everything evictable. */
  accept: boolean;
}

/**
 * Makes room for `incoming` within upload.maxQueueBytes by evicting whole groups, lowest
 * priority first, oldest first. Session records are never evicted. Incoming items are refused
 * (accept = false) rather than evicting more valuable groups than themselves.
 */
export function planEviction<T extends QueueItemMeta>(
  items: readonly T[],
  incoming: readonly QueueItemMeta[],
  policy: Pick<Policy, 'upload'>,
): EvictionResult<T> {
  const cap = policy.upload.maxQueueBytes;
  const sum = (xs: readonly QueueItemMeta[]) => xs.reduce((n, i) => n + i.bytes, 0);
  let total = sum(items) + sum(incoming);
  if (total <= cap) return { evict: [], accept: true };

  // Session records (consent, end) carry no group and are never evicted.
  const incomingPriority = Math.max(0, ...incoming.map((i) => i.priority));
  const groups = new Map<string, T[]>();
  for (const item of items) {
    if (item.group === undefined) continue; // session records are never evicted
    const members = groups.get(item.group) ?? [];
    members.push(item);
    groups.set(item.group, members);
  }
  const candidates = [...groups.values()]
    .map((members) => ({
      members,
      priority: Math.max(...members.map((m) => m.priority)),
      createdAt: Math.min(...members.map((m) => m.createdAt)),
    }))
    .filter((g) => g.priority <= incomingPriority)
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);

  const evict: T[] = [];
  for (const group of candidates) {
    if (total <= cap) break;
    evict.push(...group.members);
    total -= sum(group.members);
  }
  return total <= cap ? { evict, accept: true } : { evict: [], accept: false };
}
