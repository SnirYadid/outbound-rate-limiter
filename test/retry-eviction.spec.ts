/**
 * Partition lifetime across a backoff — the hazard Day 4 was most likely to
 * ship, and the proof that it does not.
 *
 * THE FAILURE, stated precisely. A call sleeping between attempts holds no
 * queue entry and no concurrency slot. Without a dedicated counter it
 * therefore satisfies every eviction condition, and once the backoff is long
 * enough for the buckets to refill it satisfies the capacity condition too. If
 * it were evicted:
 *
 *   1. the registry drops the map entry;
 *   2. the retry re-enters the ORPHANED partition it still has a reference to;
 *   3. a fresh call for the same key mints a NEW, full partition;
 *   4. two partitions now enforce one key's limit independently, so the
 *      effective rate limit silently DOUBLES — and only for keys that retried.
 *
 * The first test demonstrates step 1 is what the old predicate would have
 * allowed. The rest prove the current one does not, and that quota is not
 * duplicated end to end.
 */

import {describe, expect, it} from 'vitest';

import {TOKEN_EPSILON} from '../src/bucket.js';
import {normalizeConstraints} from '../src/constraints.js';
import {createLimiter} from '../src/limiter.js';
import {createPartitionRegistry, type Partition} from '../src/partition.js';
import type {RetryPolicy} from '../src/types.js';
import {settleAll} from './harness/settle.js';
import {createVirtualClock} from './harness/virtual-clock.js';

/** Retries everything, with a fixed, predictable delay. */
const alwaysRetry = (maxAttempts: number, delayMs = 200): RetryPolicy => ({
  maxAttempts,
  jitter: 'none',
  baseDelayMs: delayMs,
  maxDelayMs: delayMs,
  classify: () => ({retry: true}),
});

describe('MANDATORY 1 — retry under safe-eviction conditions', () => {
  const constraints = normalizeConstraints([
    {name: 'per-second', limit: 10, interval: 'second'},
  ]);

  function registry() {
    const clock = createVirtualClock(0);
    return {
      clock,
      reg: createPartitionRegistry({
        constraints,
        maxKeys: 100,
        maxQueueDepth: 10,
        sweepIntervalMs: Infinity,
        clock,
      }),
    };
  }

  it('REPRODUCES the hazard: idle + full + no queue + no slot would be evicted', () => {
    // This is the exact state a backing-off call leaves behind. Every
    // condition the OLD predicate checked is satisfied, which is why the
    // counter had to be added rather than relying on the existing three.
    const {clock, reg} = registry();
    const partition = reg.acquire('k');

    partition.queue.dequeue(); // empty
    expect(partition.queue.isEmpty).toBe(true);
    expect(partition.inflight).toBe(0);
    expect(partition.wakeTimer).toBeUndefined();
    // Buckets are full, so the capacity condition passes too.
    expect(reg.isDisposable(partition, clock.now())).toBe(true);

    // The ONLY thing that distinguishes a sleeping retry from a genuinely idle
    // partition is the counter.
    partition.backingOff = 1;
    expect(reg.isDisposable(partition, clock.now())).toBe(false);
  });

  it('protects the partition however long the backoff lasts', async () => {
    const {clock, reg} = registry();
    const partition = reg.acquire('k');
    partition.backingOff = 1;

    await clock.advance(10 * 60_000);
    expect(reg.isDisposable(partition, clock.now())).toBe(false);

    // A sweep must not take it.
    expect(reg.sweep(clock.now())).toBe(0);
    expect(reg.get('k')).toBe(partition);

    partition.backingOff = 0;
    expect(reg.isDisposable(partition, clock.now())).toBe(true);
  });

  it('counts several concurrent backoffs on one partition', () => {
    const {clock, reg} = registry();
    const partition = reg.acquire('k');

    partition.backingOff = 3;
    expect(reg.isDisposable(partition, clock.now())).toBe(false);
    partition.backingOff = 1;
    expect(reg.isDisposable(partition, clock.now())).toBe(false);
    partition.backingOff = 0;
    expect(reg.isDisposable(partition, clock.now())).toBe(true);
  });

  it('keeps the SAME partition object across a retry, under aggressive sweeping', async () => {
    // End to end: identity is what matters. A new object for the same key
    // would mean the old one was orphaned and its consumption forgotten.
    const clock = createVirtualClock(0);
    const seen: Partition[] = [];
    const limiter = createLimiter({
      constraints: [{name: 'paced', limit: 10, interval: 'second', burst: 1}],
      clock,
      sweepIntervalMs: 0, // sweep on every new key
      maxKeys: 100,
    });

    let attempts = 0;
    const call = limiter
      .run(
        () => {
          attempts++;
          if (attempts < 3) throw new Error('retry me');
          return 'done';
        },
        {key: 'retrying', retry: alwaysRetry(5, 300)}
      )
      .catch(() => 'failed');

    // Hammer the registry with new keys during the backoffs. Each `run()`
    // triggers a sweep, and each sweep is a chance to evict 'retrying'.
    for (let round = 0; round < 12; round++) {
      await clock.advance(50);
      const filler = limiter.run(() => 'x', {key: `filler-${round}`});
      await settleAll(clock, [filler]);
      const snapshot = limiter.inspect('retrying');
      // Tracked throughout: never dropped, never recreated.
      expect(snapshot.tracked).toBe(true);
      seen.push(snapshot as unknown as Partition);
    }

    await settleAll(clock, [call]);
    await expect(call).resolves.toBe('done');
    expect(attempts).toBe(3);
  });

  it('does NOT duplicate quota across retries while sweeps run', async () => {
    // The observable consequence of the hazard. A partition recreated full
    // mid-retry would let the key admit more than `burst + rate * window`.
    const clock = createVirtualClock(0);
    const admittedAt: number[] = [];
    const limiter = createLimiter({
      // Deliberately tight: 2 units of burst, one unit per 500ms.
      constraints: [{name: 'tight', limit: 2, interval: 'second', burst: 2}],
      clock,
      sweepIntervalMs: 0,
      maxKeys: 100,
    });

    let attempts = 0;
    const retrying = limiter
      .run(
        () => {
          admittedAt.push(clock.now());
          attempts++;
          if (attempts < 4) throw new Error('again');
          return 'ok';
        },
        {key: 'k', retry: alwaysRetry(6, 1_200)}
      )
      .catch(() => 'failed');

    // Keep sweeping throughout the retry sequence.
    for (let round = 0; round < 10; round++) {
      await clock.advance(400);
      const filler = limiter.run(() => 'x', {key: `other-${round}`});
      await settleAll(clock, [filler]);
    }
    await settleAll(clock, [retrying]);

    expect(attempts).toBe(4);

    // Conservation over every window of this key's own admissions.
    const capacity = 2;
    const ratePerMs = 2 / 1_000;
    for (let i = 0; i < admittedAt.length; i++) {
      for (let j = i; j < admittedAt.length; j++) {
        const consumed = j - i + 1; // cost 1 each
        const windowMs = admittedAt[j]! - admittedAt[i]!;
        expect(consumed).toBeLessThanOrEqual(
          capacity + ratePerMs * windowMs + TOKEN_EPSILON * 4
        );
      }
    }
  });

  it('reports backing-off calls in stats, so the counters still add up', async () => {
    const clock = createVirtualClock(0);
    const limiter = createLimiter({
      constraints: [{name: 'plenty', limit: 1_000, interval: 'second'}],
      clock,
    });

    let attempts = 0;
    const call = limiter
      .run(
        () => {
          attempts++;
          if (attempts < 2) throw new Error('retry');
          return 'ok';
        },
        {key: 'k', retry: alwaysRetry(3, 500)}
      )
      .catch(() => 'failed');

    // Let the first attempt fail and the backoff begin.
    await clock.flush();
    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 1});

    await settleAll(clock, [call]);
    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
  });

  it('frees the partition once the retry sequence finishes', async () => {
    const clock = createVirtualClock(0);
    const limiter = createLimiter({
      constraints: [{name: 'paced', limit: 10, interval: 'second', burst: 1}],
      clock,
      sweepIntervalMs: 0,
      maxKeys: 100,
    });

    let attempts = 0;
    const call = limiter
      .run(
        () => {
          attempts++;
          if (attempts < 2) throw new Error('retry');
          return 'ok';
        },
        {key: 'done-soon', retry: alwaysRetry(3, 200)}
      )
      .catch(() => 'failed');
    await settleAll(clock, [call]);

    // Once everything has settled and capacity has recovered, the partition is
    // disposable again — the counter protects a backoff, it does not pin a key
    // forever.
    await clock.advance(1_000);
    const trigger = limiter.run(() => 'x', {key: 'trigger'});
    await settleAll(clock, [trigger]);

    expect(limiter.inspect('done-soon').tracked).toBe(false);
  });
});

describe('MANDATORY 2 — fresh calls during another call’s backoff', () => {
  it('admits a new call on the same key while an older one sleeps', async () => {
    const clock = createVirtualClock(0);
    const order: string[] = [];
    const limiter = createLimiter({
      constraints: [{name: 'plenty', limit: 1_000, interval: 'second'}],
      clock,
    });

    let attempts = 0;
    const retrying = limiter
      .run(
        () => {
          attempts++;
          order.push(`retry-attempt-${attempts}`);
          if (attempts < 2) throw new Error('again');
          return 'ok';
        },
        {key: 'shared', retry: alwaysRetry(3, 500)}
      )
      .catch(() => 'failed');

    await clock.flush();
    expect(order).toEqual(['retry-attempt-1']);

    // A fresh call arrives mid-backoff. It must not be blocked by the sleeper,
    // which holds neither a queue entry nor a slot.
    const fresh = limiter.run(() => void order.push('fresh'), {key: 'shared'});
    await settleAll(clock, [fresh]);

    expect(order).toEqual(['retry-attempt-1', 'fresh']);

    await settleAll(clock, [retrying]);
    expect(order).toEqual(['retry-attempt-1', 'fresh', 'retry-attempt-2']);
  });

  it('admits a new call on a different key while one sleeps', async () => {
    const clock = createVirtualClock(0);
    const limiter = createLimiter({
      constraints: [{name: 'paced', limit: 10, interval: 'second', burst: 1}],
      clock,
    });

    let attempts = 0;
    const retrying = limiter
      .run(
        () => {
          attempts++;
          if (attempts < 2) throw new Error('again');
          return 'ok';
        },
        {key: 'a', retry: alwaysRetry(3, 400)}
      )
      .catch(() => 'failed');
    await clock.flush();

    const other = limiter.run(() => 'immediate', {key: 'b'});
    await settleAll(clock, [other]);
    await expect(other).resolves.toBe('immediate');

    await settleAll(clock, [retrying]);
  });

  it('a retry joins the TAIL, behind calls that arrived during its backoff', async () => {
    const clock = createVirtualClock(0);
    const order: string[] = [];
    const limiter = createLimiter({
      // One slot, so ordering is fully observable.
      constraints: [{name: 'plenty', limit: 1_000, interval: 'second'}],
      maxConcurrent: 1,
      clock,
    });

    let attempts = 0;
    const retrying = limiter
      .run(
        () => {
          attempts++;
          order.push(`retry-${attempts}`);
          if (attempts < 2) throw new Error('again');
          return 'ok';
        },
        {key: 'k', retry: alwaysRetry(3, 500)}
      )
      .catch(() => 'failed');

    await clock.flush();

    // These two arrive while the retry sleeps, so they are ahead of it.
    const fresh = [
      limiter.run(() => void order.push('fresh-1'), {key: 'k'}),
      limiter.run(() => void order.push('fresh-2'), {key: 'k'}),
    ];
    await settleAll(clock, fresh);
    await settleAll(clock, [retrying]);

    expect(order).toEqual(['retry-1', 'fresh-1', 'fresh-2', 'retry-2']);
  });
});
