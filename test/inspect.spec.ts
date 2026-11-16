/**
 * `inspect()` — and the proof that it is free.
 *
 * The invariant: calling `inspect()` never changes a future admission outcome
 * or when it happens. An assertion cannot establish that, because the whole
 * point is that there is nothing to observe. So the proof is differential:
 * replay identical schedules with and without intervening inspection and
 * require identical admission timelines.
 *
 * Partially depleted buckets and eviction get particular attention, because
 * those are the two places a careless implementation would leak a side effect
 * — by committing a refill, or by creating a partition.
 */

import {describe, expect, it} from 'vitest';

import {LimiterConfigError, LimiterKeyLimitError} from '../src/errors.js';
import {createLimiter} from '../src/limiter.js';
import {createSeededRandom} from '../src/random.js';
import type {RateConstraint} from '../src/types.js';
import {deferred} from './harness/deferred.js';
import {settleAll} from './harness/settle.js';
import {createVirtualClock} from './harness/virtual-clock.js';

const paced: RateConstraint[] = [{name: 'paced', limit: 10, interval: 'second', burst: 1}];
const tenPerSecond: RateConstraint[] = [{name: 'per-second', limit: 10, interval: 'second'}];

function build(constraints: RateConstraint[], extra: Record<string, unknown> = {}) {
  const clock = createVirtualClock(0);
  return {clock, limiter: createLimiter({constraints, clock, ...extra})};
}

describe('inspect — shape and content', () => {
  it('reports full capacity for an untracked key, flagged as hypothetical', () => {
    const {limiter} = build(tenPerSecond);

    const snapshot = limiter.inspect('never-seen');

    expect(snapshot).toEqual({
      key: 'never-seen',
      tracked: false,
      queued: 0,
      inflight: 0,
      waitingForCapacity: false,
      constraints: [{name: 'per-second', available: 10, capacity: 10, msUntilFull: 0}],
    });
  });

  it('does NOT create a partition for an unseen key', () => {
    const {limiter} = build(tenPerSecond);

    limiter.inspect('a');
    limiter.inspect('b');
    limiter.inspect('c');

    // Inspecting a key must not bring it into existence, or a monitoring loop
    // over candidate keys would exhaust maxKeys on its own.
    expect(limiter.stats().keys).toBe(0);
  });

  it('never throws when the registry is full, because it creates nothing', async () => {
    const {clock, limiter} = build(tenPerSecond, {maxKeys: 1});
    const gate = deferred();
    const held = limiter.run(() => gate.promise, {key: 'occupant'});

    // A `run()` on a second key cannot be served.
    await expect(limiter.run(() => 'x', {key: 'other'})).rejects.toThrow(LimiterKeyLimitError);
    // Inspection of that same key is still fine.
    expect(limiter.inspect('other').tracked).toBe(false);

    gate.resolve();
    await settleAll(clock, [held]);
  });

  it('defaults to the same key run() does', async () => {
    const {clock, limiter} = build(tenPerSecond);
    const call = limiter.run(() => 'x');
    await settleAll(clock, [call]);

    expect(limiter.inspect().key).toBe('');
    expect(limiter.inspect().tracked).toBe(true);
    expect(limiter.inspect().constraints[0]!.available).toBe(9);
  });

  it('reports a partially depleted bucket and its recovery time', async () => {
    const {clock, limiter} = build(tenPerSecond);
    const calls = Array.from({length: 4}, () => limiter.run(() => 'x', {key: 'k'}));
    await settleAll(clock, calls);

    const drained = limiter.inspect('k');
    expect(drained.tracked).toBe(true);
    expect(drained.constraints[0]!.available).toBeCloseTo(6, 9);
    expect(drained.constraints[0]!.capacity).toBe(10);
    expect(drained.constraints[0]!.msUntilFull).toBe(400);

    // Projection advances with the clock, without any call occurring.
    await clock.advance(200);
    const later = limiter.inspect('k');
    expect(later.constraints[0]!.available).toBeCloseTo(8, 9);
    expect(later.constraints[0]!.msUntilFull).toBe(200);

    await clock.advance(200);
    expect(limiter.inspect('k').constraints[0]!.available).toBe(10);
    expect(limiter.inspect('k').constraints[0]!.msUntilFull).toBe(0);
  });

  it('reports every constraint, in declaration order', async () => {
    const {clock, limiter} = build([
      {name: 'burst', limit: 5, interval: 'second'},
      {name: 'sustained', limit: 100, interval: 'minute'},
    ]);
    const call = limiter.run(() => 'x', {key: 'k'});
    await settleAll(clock, [call]);

    const snapshot = limiter.inspect('k');
    expect(snapshot.constraints.map((c) => c.name)).toEqual(['burst', 'sustained']);
    expect(snapshot.constraints[0]!.available).toBe(4);
    expect(snapshot.constraints[1]!.available).toBe(99);
  });

  it('reports queued, inflight and waitingForCapacity', async () => {
    const {clock, limiter} = build(paced, {maxConcurrent: 10});
    const gate = deferred();

    const running = limiter.run(() => gate.promise, {key: 'k'});
    const queued = limiter.run(() => 'q', {key: 'k'});

    const busy = limiter.inspect('k');
    expect(busy.inflight).toBe(1);
    expect(busy.queued).toBe(1);
    // The pump is asleep on a timer waiting for the next token.
    expect(busy.waitingForCapacity).toBe(true);

    gate.resolve();
    await settleAll(clock, [running, queued]);

    const idle = limiter.inspect('k');
    expect(idle).toMatchObject({queued: 0, inflight: 0, waitingForCapacity: false});
  });

  it('distinguishes waiting on the clock from waiting on other calls', async () => {
    const {clock, limiter} = build([{name: 'plenty', limit: 1_000, interval: 'second'}], {
      maxConcurrent: 1,
    });
    const gate = deferred();
    const held = limiter.run(() => gate.promise, {key: 'k'});
    const blocked = limiter.run(() => 'q', {key: 'k'});

    const snapshot = limiter.inspect('k');
    expect(snapshot.queued).toBe(1);
    // Blocked on a slot, not on time — so no timer, and this stays false.
    expect(snapshot.waitingForCapacity).toBe(false);

    gate.resolve();
    await settleAll(clock, [held, blocked]);
  });

  it('rejects a non-string key synchronously', () => {
    const {limiter} = build(tenPerSecond);
    expect(() => limiter.inspect(7 as unknown as string)).toThrow(LimiterConfigError);
  });

  it('hands out frozen copies, not live state', async () => {
    const {clock, limiter} = build(tenPerSecond);
    const call = limiter.run(() => 'x', {key: 'k'});
    await settleAll(clock, [call]);

    const snapshot = limiter.inspect('k');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.constraints)).toBe(true);
    expect(Object.isFrozen(snapshot.constraints[0])).toBe(true);

    // A caller cannot reach back into a bucket through the snapshot.
    expect(() => {
      (snapshot.constraints[0] as {available: number}).available = 999;
    }).toThrow();
    expect(limiter.inspect('k').constraints[0]!.available).toBe(9);
  });

  it('returns a fresh object each call rather than a shared mutable one', async () => {
    const {clock, limiter} = build(tenPerSecond);
    const call = limiter.run(() => 'x', {key: 'k'});
    await settleAll(clock, [call]);

    const first = limiter.inspect('k');
    const second = limiter.inspect('k');
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});

// ---------------------------------------------------------------------------
// The differential purity proof
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
 * Replays a schedule, optionally hammering `inspect()` at every step.
 *
 * `inspect` is called on the arriving key, on keys that have never been seen,
 * and on the default key — so the run exercises tracked buckets, partially
 * depleted buckets and the untracked path.
 */
async function replay(
  schedule: readonly Arrival[],
  constraints: RateConstraint[],
  options: {sweepIntervalMs: number; maxKeys: number},
  inspecting: boolean
): Promise<Admission[]> {
  const clock = createVirtualClock(0);
  const limiter = createLimiter({constraints, clock, ...options});
  const timeline: Admission[] = [];
  const pending: Promise<unknown>[] = [];
  let cursor = 0;

  const probe = (key: string): void => {
    if (!inspecting) return;
    limiter.inspect(key);
    limiter.inspect(`${key}-never-seen`);
    limiter.inspect();
    limiter.inspect(key);
  };

  for (const arrival of schedule) {
    probe(arrival.key);
    if (arrival.at > cursor) {
      await clock.advance(arrival.at - cursor);
      cursor = arrival.at;
    }
    probe(arrival.key);
    pending.push(
      limiter
        .run(
          () => {
            timeline.push({key: arrival.key, at: clock.now()});
            probe(arrival.key);
          },
          {key: arrival.key, cost: arrival.cost}
        )
        .catch(() => undefined)
    );
    probe(arrival.key);
  }

  await settleAll(clock, pending);
  probe('final');
  return timeline;
}

function scheduleFor(seed: number, keyCount: number, length: number): Arrival[] {
  const random = createSeededRandom(seed);
  const schedule: Arrival[] = [];
  let at = 0;
  for (let index = 0; index < length; index++) {
    at += Math.floor(random() * 260);
    schedule.push({
      at,
      key: `key-${Math.floor(random() * keyCount)}`,
      cost: 1 + Math.floor(random() * 3),
    });
  }
  return schedule;
}

describe('inspect — differential purity', () => {
  const constraints: RateConstraint[] = [
    {name: 'burst', limit: 5, interval: 'second', burst: 5},
    {name: 'sustained', limit: 20, interval: 'minute', burst: 5},
  ];

  for (const seed of [1, 2, 3, 7, 11, 23, 101, 1013]) {
    it(`admission timeline is identical with and without inspect() (seed ${seed})`, async () => {
      const schedule = scheduleFor(seed, 6, 60);

      const withoutInspection = await replay(
        schedule,
        constraints,
        {sweepIntervalMs: Infinity, maxKeys: 100},
        false
      );
      const withInspection = await replay(
        schedule,
        constraints,
        {sweepIntervalMs: Infinity, maxKeys: 100},
        true
      );

      expect(withInspection).toEqual(withoutInspection);
      expect(withInspection).toHaveLength(schedule.length);
    });
  }

  for (const seed of [5, 13, 97]) {
    it(`stays identical with eviction active too (seed ${seed})`, async () => {
      // Eviction plus inspection is the dangerous combination: if inspect()
      // created partitions, it would change what the sweep finds; if it
      // committed refills, it would change when a partition becomes
      // disposable.
      const schedule = scheduleFor(seed, 5, 50);

      const withoutInspection = await replay(
        schedule,
        constraints,
        {sweepIntervalMs: 0, maxKeys: 100},
        false
      );
      const withInspection = await replay(
        schedule,
        constraints,
        {sweepIntervalMs: 0, maxKeys: 100},
        true
      );

      expect(withInspection).toEqual(withoutInspection);
    });
  }

  it('does not commit a refill on a partially depleted bucket', async () => {
    // The specific mistake: admission writes refilled buckets back as an
    // optimisation. If inspection did the same, it would be writing state on a
    // read path. Observable through eviction — a written-back refill must not
    // change when the partition becomes disposable.
    const {clock, limiter} = build(paced, {sweepIntervalMs: 0, maxKeys: 100});

    const call = limiter.run(() => 'x', {key: 'k'});
    await settleAll(clock, [call]);
    expect(limiter.stats().keys).toBe(1);

    // 50ms in, the bucket is half refilled. Inspect repeatedly.
    await clock.advance(50);
    for (let i = 0; i < 20; i++) limiter.inspect('k');

    // Still not disposable: capacity has not fully returned. A new key forces
    // a sweep, and 'k' must survive it.
    const other = limiter.run(() => 'y', {key: 'other'});
    await settleAll(clock, [other]);
    expect(limiter.inspect('k').tracked).toBe(true);

    // Once genuinely full it becomes disposable, inspection or not.
    await clock.advance(100);
    for (let i = 0; i < 20; i++) limiter.inspect('k');
    const third = limiter.run(() => 'z', {key: 'third'});
    await settleAll(clock, [third]);
    expect(limiter.inspect('k').tracked).toBe(false);
  });

  it('does not schedule a timer', async () => {
    const {clock, limiter} = build(paced);
    const call = limiter.run(() => 'x', {key: 'k'});
    await settleAll(clock, [call]);
    expect(clock.pendingTimers()).toBe(0);

    for (let i = 0; i < 50; i++) {
      limiter.inspect('k');
      limiter.inspect('unseen');
    }

    expect(clock.pendingTimers()).toBe(0);
  });

  it('does not enqueue work or alter the counters', async () => {
    const {clock, limiter} = build(paced, {maxConcurrent: 10});
    const gate = deferred();
    const running = limiter.run(() => gate.promise, {key: 'k'});
    const queued = limiter.run(() => 'q', {key: 'k'});

    const before = limiter.stats();
    for (let i = 0; i < 50; i++) limiter.inspect('k');
    expect(limiter.stats()).toEqual(before);

    gate.resolve();
    await settleAll(clock, [running, queued]);
  });
});
