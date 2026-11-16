/**
 * Per-key state, and the registry that owns it.
 *
 * Rate state is partitioned by key and never shared, which has a consequence
 * worth stating because the scheduler depends on it: within one key, available
 * capacity only ever GROWS with time. No other key can take it. That is why
 * the pump never has to re-check rate capacity after waiting for a concurrency
 * slot, and therefore why admission needs no retry loop.
 *
 * Eviction is the other thing this module exists to get right. See
 * docs/GUARANTEES.md, "Key eviction": a partition is disposable only when
 * dropping it is indistinguishable from keeping it.
 */

import {createBucket, isFull, type BucketState} from './bucket.js';
import type {NormalizedConstraint} from './constraints.js';
import {LimiterKeyLimitError} from './errors.js';
import {BoundedFifo} from './queue.js';
import type {CancelTimer, Clock} from './time.js';

/** One queued call, waiting for capacity. */
export interface QueuedCall {
  /** Units this call will consume from every constraint. */
  readonly cost: number;
  /** Clock reading when the call first entered the queue. */
  readonly enqueuedAt: number;
  /** Attempts started so far. Read by the scheduler for telemetry. */
  readonly attemptsMade: () => number;
  /**
   * True when the call's total budget has run out.
   *
   * Asked by the pump BEFORE admission, so an expired call can never spend
   * capacity — which matters because capacity is never refunded.
   */
  readonly isExpired: (now: number) => boolean;
  /**
   * Called by the pump when `isExpired` returned true, after dequeueing. Must
   * settle the call and must not throw.
   */
  readonly expire: () => void;
  /**
   * Starts one attempt and takes ownership of `release`.
   *
   * Also takes ownership of the per-key `inflight` count: it increments on
   * entry and decrements when the attempt settles, so a caller admits and then
   * simply starts. Callers must not adjust `inflight` themselves.
   *
   * MUST NOT throw: it is invoked from inside the pump loop, where a throw
   * would abandon the queue and leak the slot. The implementation catches
   * everything the caller's function can do. May be called more than once over
   * a call's life — once per attempt.
   */
  readonly start: (release: () => void) => void;
}

export interface Partition {
  readonly key: string;
  /** Index-aligned with the limiter's normalized constraints. */
  readonly buckets: BucketState[];
  readonly queue: BoundedFifo<QueuedCall>;
  /** Attempts started and not yet settled. */
  inflight: number;
  /**
   * Calls sleeping between attempts.
   *
   * A backing-off call holds no queue entry and no concurrency slot, so this
   * counter is the ONLY thing keeping its partition from being evicted
   * underneath it. See the state table in call.ts.
   */
  backingOff: number;
  /** True while the pump loop is running, to prevent re-entry. */
  pumping: boolean;
  /** Set when the pump is sleeping until rate capacity returns. */
  wakeTimer: CancelTimer | undefined;
}

export interface PartitionRegistryOptions {
  readonly constraints: readonly NormalizedConstraint[];
  readonly maxKeys: number;
  readonly maxQueueDepth: number;
  /**
   * How often an eviction sweep may run, in milliseconds. `0` sweeps on every
   * new key; `Infinity` never sweeps on a schedule. A sweep is additionally
   * forced when the registry is full, because refusing a caller while
   * disposable keys sit in the map would be a bug rather than a limit.
   */
  readonly sweepIntervalMs: number;
  readonly clock: Clock;
}

export interface PartitionRegistry {
  /** Returns the key's partition, creating it if needed. Throws when full. */
  acquire(key: string): Partition;
  get(key: string): Partition | undefined;
  /** True when dropping this partition would be unobservable. */
  isDisposable(partition: Partition, now: number): boolean;
  /** Drops every disposable partition. Returns how many went. */
  sweep(now: number): number;
  readonly size: number;
  totalQueued(): number;
  totalInflight(): number;
  totalBackingOff(): number;
}

export function createPartitionRegistry(
  options: PartitionRegistryOptions
): PartitionRegistry {
  const {constraints, maxKeys, maxQueueDepth, sweepIntervalMs, clock} = options;
  const partitions = new Map<string, Partition>();
  let lastSweepAt = Number.NEGATIVE_INFINITY;

  const isDisposable = (partition: Partition, now: number): boolean => {
    // P1: never evict a partition with outstanding work. Checked first and
    // cheapest; the capacity test below is the subtle one.
    if (!partition.queue.isEmpty) return false;
    if (partition.inflight > 0) return false;
    // Without this, a call sleeping between attempts would be invisible: no
    // queue entry, no slot, so the partition would look idle and be evicted —
    // and the retry would then re-enter an orphaned partition while a fresh
    // call minted a new, full one, silently doubling the key's limit.
    if (partition.backingOff > 0) return false;
    if (partition.wakeTimer !== undefined) return false;

    // P2: a bucket at capacity carries no information, because a partition is
    // created full (P4). So dropping it and recreating it later is
    // indistinguishable from keeping it. A bucket that is NOT full records
    // consumption that has not yet been paid back by elapsed time, and
    // discarding it would hand out that capacity for free.
    return constraints.every((constraint, index) => {
      const bucket = partition.buckets[index];
      return bucket !== undefined && isFull(bucket, now, constraint.spec);
    });
  };

  const sweep = (now: number): number => {
    lastSweepAt = now;
    let evicted = 0;
    for (const [key, partition] of partitions) {
      if (isDisposable(partition, now)) {
        partitions.delete(key);
        evicted++;
      }
    }
    return evicted;
  };

  return {
    acquire: (key) => {
      const existing = partitions.get(key);
      if (existing !== undefined) return existing;

      const now = clock.now();

      if (partitions.size >= maxKeys) {
        // Forced, regardless of the sweep interval: turning away a caller
        // while disposable keys are still in the map is not a limit, it is a
        // missed cleanup.
        sweep(now);
        if (partitions.size >= maxKeys) {
          throw new LimiterKeyLimitError(
            `Cannot track a new key: ${partitions.size} keys are in use and none can be ` +
              'evicted safely (each has queued or running work, or capacity it has not yet ' +
              'paid back). Raise maxKeys, or use a coarser key — a key derived from a ' +
              'request id rather than a credential is the usual cause.',
            {key}
          );
        }
      } else if (now - lastSweepAt >= sweepIntervalMs) {
        sweep(now);
      }

      const partition: Partition = {
        key,
        // P4: a key nobody has used has consumed nothing, so it starts full.
        buckets: constraints.map((constraint) => createBucket(now, constraint.spec)),
        queue: new BoundedFifo<QueuedCall>(maxQueueDepth),
        inflight: 0,
        backingOff: 0,
        pumping: false,
        wakeTimer: undefined,
      };
      partitions.set(key, partition);
      return partition;
    },

    get: (key) => partitions.get(key),

    isDisposable,
    sweep,

    get size() {
      return partitions.size;
    },

    // Iterating rather than maintaining running counters: these are read by
    // operators and tests, never on the admission path, and a derived counter
    // is one more thing that can drift out of step with the truth.
    totalQueued: () => {
      let total = 0;
      for (const partition of partitions.values()) total += partition.queue.size;
      return total;
    },
    totalInflight: () => {
      let total = 0;
      for (const partition of partitions.values()) total += partition.inflight;
      return total;
    },
    totalBackingOff: () => {
      let total = 0;
      for (const partition of partitions.values()) total += partition.backingOff;
      return total;
    },
  };
}
