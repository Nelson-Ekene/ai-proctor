import { backoffMs, expiredItems, nextDue, nextWakeAt, planEviction } from '@proctor/core';
import type { MediaStore, QueueItem } from '../shared/evidence-store';

// Upload client (FR12): drains the persistent queue in priority order with exponential backoff.
// - HTTPS only (plain HTTP is allowed for localhost development).
// - Every request carries Idempotency-Key = the item id, so a retry after a lost response is
//   recognised by the server and never double-counts.
// - Media is read from IndexedDB at send time and deleted locally once acknowledged.

export interface UploaderDeps {
  queue: {
    list(): Promise<QueueItem[]>;
    put(items: readonly QueueItem[]): Promise<void>;
    remove(ids: readonly string[]): Promise<void>;
  };
  media: {
    get(ref: { store: MediaStore; id: string }): Promise<Blob | undefined>;
    remove(ref: { store: MediaStore; id: string }): Promise<void>;
    list(): Promise<{ store: MediaStore; id: string; sessionId: string }[]>;
  };
  /** The session still capturing (its media may belong to windows not yet packaged). */
  activeSessionId(): Promise<string | undefined>;
  fetch: typeof fetch;
  now(): number;
  rng(): number;
  /** Arrange for drain() to run again at `at` (alarm and/or timer). */
  schedule(at: number): void;
  log?(message: string, error?: unknown): void;
  trace?(message: string): void;
}

/** Transport timeout per request (network hygiene, not a product threshold). */
const REQUEST_TIMEOUT_MS = 30_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

type Outcome = 'sent' | 'retry' | 'drop';

export function isSecureApi(apiBase: string): boolean {
  try {
    const url = new URL(apiBase);
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

/** Retry on network errors, timeouts, 408, 429 and 5xx; other 4xx can never succeed. */
function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export class Uploader {
  private running: Promise<void> | undefined;
  private again = false;

  constructor(private readonly deps: UploaderDeps) {}

  /**
   * Adds items, evicting the lowest-value anomaly groups if the queue would exceed its cap.
   * Returns false if the items were refused (they and their local media are then discarded).
   */
  async enqueue(items: readonly QueueItem[]): Promise<boolean> {
    if (items.length === 0) return true;
    const sized = await Promise.all(
      items.map(async (item) => {
        if (!item.request.media) return item;
        const blob = await this.deps.media.get(item.request.media);
        return { ...item, bytes: blob?.size ?? 0 };
      }),
    );
    const existing = await this.deps.queue.list();
    const { retry } = items[0] as QueueItem; // non-empty, checked above
    const plan = planEviction(existing, sized, { upload: retry });
    if (!plan.accept) {
      this.deps.log?.(`upload queue full: refusing ${String(items.length)} items`);
      await this.discard(sized);
      return false;
    }
    if (plan.evict.length > 0) {
      this.deps.log?.(`upload queue full: evicting ${String(plan.evict.length)} lower-value items`);
      await this.discard(plan.evict);
    }
    await this.deps.queue.put(sized);
    return true;
  }

  /** Sends everything that is due. Concurrent calls coalesce into one run. */
  drain(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.loop().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async loop(): Promise<void> {
    do {
      for (;;) {
        let items = await this.deps.queue.list();
        const expired = expiredItems(items, this.deps.now());
        if (expired.length > 0) {
          this.deps.log?.(`dropping ${String(expired.length)} expired upload items`);
          await this.discard(expired);
          items = items.filter((i) => !expired.includes(i));
        }
        const item = nextDue(items, this.deps.now());
        if (!item) {
          await this.sweepOrphans(items);
          const wake = nextWakeAt(items);
          if (wake !== undefined) this.deps.schedule(wake);
          break;
        }
        const outcome = await this.send(item);
        if (outcome === 'retry') {
          const attempts = item.attempts + 1;
          const delay = backoffMs(attempts, { upload: item.retry }, () => this.deps.rng());
          await this.deps.queue.put([
            { ...item, attempts, nextAttemptAt: this.deps.now() + delay },
          ]);
          this.deps.trace?.(
            `upload ${item.kind} ${item.id} retry #${String(attempts)} in ${delay.toFixed(0)}ms`,
          );
        } else {
          await this.discard([item]);
          this.deps.trace?.(`upload ${item.kind} ${item.id} ${outcome}`);
        }
      }
    } while (this.takeAgain());
  }

  /** Reads and clears the "more work arrived during the run" flag (set by drain()). */
  private takeAgain(): boolean {
    const again = this.again;
    this.again = false;
    return again;
  }

  private async send(item: QueueItem): Promise<Outcome> {
    const req = item.request;
    if (!isSecureApi(req.apiBase)) {
      this.deps.log?.(`refusing insecure upload target ${req.apiBase}`);
      return 'drop';
    }
    let body: BodyInit | undefined = req.body;
    if (req.media) {
      const blob = await this.deps.media.get(req.media);
      if (!blob) {
        // Already uploaded for another anomaly sharing this evidence, or purged.
        this.deps.trace?.(`upload ${item.id}: media no longer stored`);
        return 'drop';
      }
      body = blob;
    }
    try {
      const res = await this.deps.fetch(`${req.apiBase.replace(/\/+$/, '')}${req.path}`, {
        method: req.method,
        headers: {
          authorization: `Bearer ${req.token}`,
          'content-type': req.contentType,
          'idempotency-key': item.id,
        },
        body: body ?? null,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return 'sent';
      if (retryable(res.status)) return 'retry';
      this.deps.log?.(`upload ${item.kind} ${item.id} rejected with ${String(res.status)}`);
      return 'drop';
    } catch (error) {
      this.deps.trace?.(`upload ${item.kind} ${item.id} network error: ${String(error)}`);
      return 'retry';
    }
  }

  /**
   * Deletes stored frames/clips that belong to no capturing session and are not waiting in the
   * queue: e.g. a burst that finished after its anomaly was packaged, or a frame analysed while
   * the session was ending. Nothing that is not evidence may stay on the device.
   */
  private async sweepOrphans(queue: readonly QueueItem[]): Promise<void> {
    const active = await this.deps.activeSessionId();
    const queued = new Set(queue.flatMap((i) => (i.request.media ? [i.request.media.id] : [])));
    const orphans = (await this.deps.media.list()).filter(
      (m) => m.sessionId !== active && !queued.has(m.id),
    );
    for (const media of orphans) await this.deps.media.remove(media);
    if (orphans.length > 0) this.deps.trace?.(`swept ${String(orphans.length)} orphaned media`);
  }

  /** Removes items from the queue and deletes their local media. */
  private async discard(items: readonly QueueItem[]): Promise<void> {
    await this.deps.queue.remove(items.map((i) => i.id));
    for (const item of items) {
      if (item.request.media) await this.deps.media.remove(item.request.media);
    }
  }
}
