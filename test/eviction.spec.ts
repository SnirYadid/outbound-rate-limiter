/**
 * Safe eviction, and the differential test that proves it.
 *
 * The claim under test: a partition is dropped only when dropping it is
 * indistinguishable from keeping it. An assertion cannot establish that — the
 * whole point is that there is nothing to observe. So the proof is
 * differential: run identical arrival schedules with eviction forced and with
 * eviction disabled, and require identical admission timelines.
 *
 * If `isDisposable` ever admits a partially drained bucket, the eviction run
 * recreates it full, admits earlier somewhere, and the timelines diverge.
 */

import {describe, expect, it} from 'vitest';

import {isFull} from '../src/bucket.js';
import {normalizeConstraints} from '../src/constraints.js';
import {createLimiter} from '../src/limiter.js';
import {createPartitionRegistry} from '../src/partition.js';
import {createSeededRandom} from '../src/random.js';
import type {RateConstraint} from '../src/types.js';
import {settleAll} from './harness/settle.js';
import {createVirtualClock} from './harness/virtual-clock.js';

const paced: RateConstraint[] = [{name: 'paced', limit: 10, interval: 'second', burst: 1}];

describe('MANDATORY 8 — safe eviction', () => {
  const constraints = normalizeConstraints([
    {name: 'per-second', limit: 10, interval: 'second'},
  ]);

  function registry(overrides: Partial<Parameters<typeof createPartitionRegistry>[0]> = {}) {
    const clock = createVirtualClock(0);
    return {
      clock,
      reg: createPartitionRegistry({
        constraints,
        maxKeys: 100,
        maxQueueDepth: 10,
        sweepIntervalMs: 0,
        clock,
        ...overrides,
      }),
    };
  }

  it('considers a fresh partition disposable: it is full and idle', () => {
    const {clock, reg} = registry();
    const partition = reg.acquire('k');
    expect(reg.isDisposable(partition, clock.now())).toBe(true);
  });

  it('REFUSES to evict a partition whose capacity is not fully restored', () => {
    // The central safety property. A drained bucket records consumption that
    // elapsed time has not yet paid back; discarding it would hand that
    // capacity out for free.
    const {clock, reg} = registry();
    const partition = reg.acquire('k');
    const spec = constraints[0]!.spec;
    partition.buckets[0] = {tokens: 4, updatedAt: clock.now()};

    expect(isFull(partition.buckets[0]!, clock.now(), spec)).toBe(false);
    expect(reg.isDisposable(partition, clock.now())).toBe(false);
  });

  it('refuses to evict a partition with queued work', () => {
    const {clock, reg} = registry();
    const partition = reg.acquire('k');
    partition.queue.enqueue({
      cost: 1,
      enqueuedAt: 0,
      isExpired: () => false,
      expire: () => {},
      start: () => {},
    });

    expect(reg.isDisposable(partition, clock.now())).toBe(false);
  });

  it('refuses to evict a partition with running work', () => {
    const {clock, reg} = registry();
    const partition = reg.acquire('k');
    partition.inflight = 1;

    expect(reg.isDisposable(partition, clock.now())).toBe(false);
  });

  it('refuses to evict a partition whose pump is sleeping', () => {
    const {clock, reg} = registry();
    const partition = reg.acquire('k');
    partition.wakeTimer = () => {};

    expect(reg.isDisposable(partition, clock.now())).toBe(false);
  });

  it('becomes disposable again once capacity has fully refilled', async () => {
    const {clock, reg} = registry();
    const partition = reg.acquire('k');
    partition.buckets[0] = {tokens: 0, updatedAt: clock.now()};

    expect(reg.isDisposable(partition, clock.now())).toBe(false);

    await clock.advance(999);
    expect(reg.isDisposable(partition, clock.now())).toBe(false);

    await clock.advance(1);
    expect(reg.isDisposable(partition, clock.now())).toBe(true);
  });

  it('sweeps only the disposable partitions', () => {
    // sweepIntervalMs: Infinity so acquiring a key does not sweep behind our
    // back — this test drives the sweep explicitly.
    const {clock, reg} = registry({sweepIntervalMs: Infinity});
    reg.acquire('idle');
    const busy = reg.acquire('busy');
    const drained = reg.acquire('drained');

    busy.inflight = 1;
    drained.buckets[0] = {tokens: 0, updatedAt: clock.now()};

    expect(reg.size).toBe(3);
    expect(reg.sweep(clock.now())).toBe(1);
    expect(reg.size).toBe(2);
    expect(reg.get('idle')).toBeUndefined();
    expect(reg.get('busy')).toBe(busy);
    expect(reg.get('drained')).toBe(drained);
  });

  it('honours the sweep interval, and forces a sweep when full', () => {
    const {reg} = registry({maxKeys: 2, sweepIntervalMs: Infinity});

    reg.acquire('a');
    reg.acquire('b');
    expect(reg.size).toBe(2);

    // Both are disposable, but the interval says never sweep on a schedule.
    // Being full forces one anyway — refusing a caller while disposable keys
    // sit in the map would be a missed cleanup, not a limit.
    reg.acquire('c');
    expect(reg.size).toBeLessThanOrEqual(2);
    expect(reg.get('c')).toBeDefined();
  });

  it('reuses the existing partition for a key it already tracks', () => {
    const {reg} = registry({});
    const first = reg.acquire('k');
    first.inflight = 1;

    expect(reg.acquire('k')).toBe(first);
    expect(reg.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The differential test
// ---------------------------------------------------------------------------

interface Arrival {
  readonly at: number;
  readonly key: string;
  readonly cost: number;
}

interface Admission {
  readonly key: string;
  readonly at: number;
}

/**
 * Replays an arrival schedule and returns when each call actually started.
 *
 * Deterministic: the clock is virtual, the work is synchronous, and arrivals
 * are driven in schedule order.
 */
async function replay(
  schedule: readonly Arrival[],
  constraints: RateConstraint[],
  options: {sweepIntervalMs: number; maxKeys: number}
): Promise<Admission[]> {
  const clock = createVirtualClock(0);
  const limiter = createLimiter({constraints, clock, ...options});
  const timeline: Admission[] = [];
  const pending: Promise<unknown>[] = [];
  let cursor = 0;

  for (const arrival of schedule) {
    if (arrival.at > cursor) {
      await clock.advance(arrival.at - cursor);
      cursor = arrival.at;
    }
    pending.push(
      limiter
        .run(
          () => {
            timeline.push({key: arrival.key, at: clock.now()});
          },
          {key: arrival.key, cost: arrival.cost}
        )
        .catch(() => undefined)
    );
  }

  await settleAll(clock, pending);
  return timeline;
}

/** Builds a varied but reproducible schedule from a seed. */
function scheduleFor(seed: number, keyCount: number, length: number): Arrival[] {
  const random = createSeededRandom(seed);
  const schedule: Arrival[] = [];
  let at = 0;
  for (let index = 0; index < length; index++) {
    // Gaps sometimes long enough for a partition to refill and become
    // disposable, sometimes far too short — both paths need exercising.
    at += Math.floor(random() * 260);
    schedule.push({
      at,
      key: `key-${Math.floor(random() * keyCount)}`,
      cost: 1 + Math.floor(random() * 3),
    });
  }
  return schedule;
}

describe('differential eviction', () => {
  const constraints: RateConstraint[] = [
    {name: 'burst', limit: 5, interval: 'second', burst: 5},
    {name: 'sustained', limit: 20, interval: 'minute', burst: 5},
  ];

  // Several seeds, not one hand-picked example.
  for (const seed of [1, 2, 3, 7, 11, 23, 101, 1013]) {
    it(`produces an identical admission timeline with and without eviction (seed ${seed})`, async () => {
      const schedule = scheduleFor(seed, 6, 60);

      const withEviction = await replay(schedule, constraints, {
        sweepIntervalMs: 0, // sweep on every new key
        maxKeys: 100,
      });
      const withoutEviction = await replay(schedule, constraints, {
        sweepIntervalMs: Infinity, // never sweep on a schedule
        maxKeys: Infinity, // and never forced to
      });

      expect(withEviction).toEqual(withoutEviction);
      expect(withEviction).toHaveLength(schedule.length);
    });
  }

  it('actually evicts during the eviction run, so the comparison is meaningful', async () => {
    // Guards against the test passing because nothing was ever evicted.
    const clock = createVirtualClock(0);
    const limiter = createLimiter({
      constraints: paced,
      clock,
      sweepIntervalMs: 0,
      maxKeys: 100,
    });

    for (const key of ['a', 'b', 'c']) {
      await limiter.run(() => key, {key});
    }
    expect(limiter.stats().keys).toBe(3);

    // Let every partition refill, then touch a new key to trigger the sweep.
    await clock.advance(1_000);
    await limiter.run(() => 'd', {key: 'd'});

    // The three idle partitions were dropped; only the new one remains.
    expect(limiter.stats().keys).toBe(1);
  });

  it('does not evict mid-flight partitions even with aggressive sweeping', async () => {
    const clock = createVirtualClock(0);
    const limiter = createLimiter({
      constraints: paced,
      clock,
      sweepIntervalMs: 0,
      maxKeys: 100,
      maxConcurrent: 10,
    });

    let release!: () => void;
    const held = limiter.run(() => new Promise<void>((resolve) => {
      release = resolve;
    }), {key: 'busy'});

    // Many sweeps, all while 'busy' has work in flight.
    await clock.advance(5_000);
    for (let index = 0; index < 20; index++) {
      await limiter.run(() => 'x', {key: `other-${index}`});
    }

    expect(limiter.stats().inflight).toBe(1);

    release();
    await held;
  });
});
