import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, parsePolicy } from './policy';
import {
  backoffMs,
  expiredItems,
  nextDue,
  nextWakeAt,
  planEviction,
  priorityFor,
  type QueueItemMeta,
} from './upload';

let seq = 0;
function item(over: Partial<QueueItemMeta> = {}): QueueItemMeta {
  seq += 1;
  return {
    id: `i${String(seq).padStart(3, '0')}`,
    sessionId: 's1',
    kind: 'evidence',
    priority: 12,
    bytes: 100,
    createdAt: seq,
    attempts: 0,
    nextAttemptAt: 0,
    expiresAt: 10_000_000,
    ...over,
  };
}

describe('priorityFor', () => {
  it('sends the consent decision first, anomaly groups by severity, and the end record last', () => {
    expect(priorityFor('consent')).toBe(100);
    expect(priorityFor('end')).toBe(1);
    expect(priorityFor('end')).toBeLessThan(priorityFor('evidence', 'low'));
    expect(priorityFor('anomaly', 'high')).toBeGreaterThan(priorityFor('anomaly', 'medium'));
    expect(priorityFor('evidence', 'medium')).toBeGreaterThan(priorityFor('evidence', 'low'));
    expect(priorityFor('evidence')).toBe(10);
  });
});

describe('backoffMs', () => {
  it('doubles from the base, with equal jitter, capped at the maximum', () => {
    expect(backoffMs(1, DEFAULT_POLICY, () => 0)).toBe(1000); // half of 2000
    expect(backoffMs(1, DEFAULT_POLICY, () => 0.999999)).toBeCloseTo(2000, 0);
    expect(backoffMs(2, DEFAULT_POLICY, () => 0)).toBe(2000); // half of 4000
    expect(backoffMs(3, DEFAULT_POLICY, () => 0)).toBe(4000);
    expect(backoffMs(30, DEFAULT_POLICY, () => 1)).toBe(300_000);
    expect(backoffMs(0, DEFAULT_POLICY, () => 0)).toBe(1000);
  });

  it('follows the policy', () => {
    const p = parsePolicy({
      ...DEFAULT_POLICY,
      upload: { ...DEFAULT_POLICY.upload, retryBaseMs: 100, retryMaxMs: 400 },
    });
    expect(backoffMs(5, p, () => 1)).toBe(400);
    expect(() =>
      parsePolicy({
        ...DEFAULT_POLICY,
        upload: { ...DEFAULT_POLICY.upload, retryBaseMs: 500, retryMaxMs: 400 },
      }),
    ).toThrow(/retryBaseMs/);
  });
});

describe('nextDue', () => {
  it('picks the highest priority due item, oldest first', () => {
    const low = item({ priority: 11 });
    const highOld = item({ priority: 13 });
    const highNew = item({ priority: 13 });
    const session = item({ kind: 'consent', priority: 100 });
    expect(nextDue([low, highNew, highOld], 0)?.id).toBe(highOld.id);
    expect(nextDue([low, highNew, session], 0)?.id).toBe(session.id);
  });

  it('skips items that are not due yet', () => {
    const later = item({ priority: 100, nextAttemptAt: 5000 });
    const now = item({ priority: 11 });
    expect(nextDue([later, now], 1000)?.id).toBe(now.id);
    expect(nextDue([later], 1000)).toBeUndefined();
    expect(nextDue([later], 5000)?.id).toBe(later.id);
  });

  it('sends an anomaly record before its evidence', () => {
    const anomaly = item({ kind: 'anomaly', priority: 12 });
    const evidence = item({ priority: 50, dependsOn: anomaly.id });
    expect(nextDue([evidence, anomaly], 0)?.id).toBe(anomaly.id);
    // once the record is acknowledged (removed), the evidence goes
    expect(nextDue([evidence], 0)?.id).toBe(evidence.id);
  });

  it('breaks full ties by id for determinism', () => {
    const a = item({ id: 'a', createdAt: 1 });
    const b = item({ id: 'b', createdAt: 1 });
    expect(nextDue([b, a], 0)?.id).toBe('a');
    expect(nextDue([a, b], 0)?.id).toBe('a');
  });
});

describe('nextWakeAt and expiry', () => {
  it('returns the earliest due time', () => {
    expect(nextWakeAt([])).toBeUndefined();
    expect(nextWakeAt([item({ nextAttemptAt: 900 }), item({ nextAttemptAt: 300 })])).toBe(300);
  });

  it('finds expired items', () => {
    const old = item({ expiresAt: 100 });
    const fresh = item({ expiresAt: 1000 });
    expect(expiredItems([old, fresh], 100)).toEqual([old]);
  });
});

describe('planEviction', () => {
  const capped = parsePolicy({
    ...DEFAULT_POLICY,
    upload: { ...DEFAULT_POLICY.upload, maxQueueBytes: 1000 },
  });

  it('evicts nothing within the cap', () => {
    expect(planEviction([item({ bytes: 400 })], [item({ bytes: 500 })], capped)).toEqual({
      evict: [],
      accept: true,
    });
  });

  it('evicts whole groups, lowest priority and oldest first', () => {
    const lowOld = [
      item({ group: 'g1', priority: 11, bytes: 300 }),
      item({ group: 'g1', priority: 11, bytes: 100 }),
    ];
    const lowNew = [item({ group: 'g2', priority: 11, bytes: 300 })];
    const high = [item({ group: 'g3', priority: 13, bytes: 200 })];
    const r = planEviction(
      [...high, ...lowNew, ...lowOld],
      [item({ group: 'g4', priority: 13, bytes: 300 })],
      capped,
    );
    expect(r.accept).toBe(true);
    expect(r.evict.map((e) => e.group)).toEqual(['g1', 'g1']); // 1200 -> 800
  });

  it('never evicts session records and refuses lower-value incoming items', () => {
    const end = item({ kind: 'end', priority: 100, bytes: 900 });
    const high = [item({ group: 'g1', priority: 13, bytes: 100 })];
    const lowIncoming = [item({ group: 'g2', priority: 11, bytes: 200 })];
    expect(planEviction([end, ...high], lowIncoming, capped)).toEqual({ evict: [], accept: false });
  });

  it('refuses when even evicting every eligible group is not enough', () => {
    const small = [item({ group: 'g1', priority: 11, bytes: 100 })];
    expect(planEviction(small, [item({ group: 'g2', priority: 13, bytes: 2000 })], capped)).toEqual(
      {
        evict: [],
        accept: false,
      },
    );
  });
});
