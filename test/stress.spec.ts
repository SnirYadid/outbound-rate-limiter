/**
 * Scheduler stress properties, pinned so a refactor cannot quietly undo them.
 *
 * Two limitations were carried in the notes from earlier days. One turned out
 * not to exist; the other is real but bounded. Both are measured here rather
 * than asserted in prose.
 */

import {describe, expect, it} from 'vitest';

import {createLimiter} from '../src/limiter.js';
import type {RateConstraint, RetryPolicy} from '../src/types.js';
import {ignore} from './harness/deferred.js';
import {settleAll} from './harness/settle.js';
import {createVirtualClock} from './harness/virtual-clock.js';

const generous: RateConstraint[] = [
  {name: 'generous', limit: 1_000_000, interval: 'second', burst: 100_000},
];

const alwaysRetry = (maxAttempts: number, delayMs: number): RetryPolicy => ({
  maxAttempts,
  jitter: 'none',
  baseDelayMs: delayMs,
  maxDelayMs: delayMs,
  classify: () => ({retry: true}),
});

/** Frames in the current stack. Crude, but it is the thing under test. */
const stackDepth = (): number => (new Error().stack ?? '').split('\n').length;

describe('stress — the pump does not grow the stack', () => {
  /**
   * An earlier note claimed a synchronous-failure storm nested one pump frame
   * per key. It does not. Three independent reentrancy guards make the pump
   * effectively iterative:
   *
   *   - `partition.pumping` collapses a re-entrant pump on the same key;
   *   - the semaphore's `draining` flag means a nested release returns at once
   *     instead of starting another pump chain, so waiters are served in one
   *     flat `while` loop;
   *   - the emitter's `delivering` flag does the same for telemetry.
   *
   * The property is not "depth is below some number" — it is "depth does not
   * depend on the workload". So the test compares two scales that differ by
   * 50x and requires the same answer.
   */
  async function measureDepth(keys: number, callsPerKey: number): Promise<number> {
    const clock = createVirtualClock(0);
    const limiter = createLimiter({constraints: generous, clock, maxConcurrent: 1});
    const baseline = stackDepth();
    let deepest = 0;

    const calls: Promise<unknown>[] = [];
    for (let k = 0; k < keys; k++) {
      for (let c = 0; c < callsPerKey; c++) {
        calls.push(
          ignore(
            limiter.run(
              () => {
                deepest = Math.max(deepest, stackDepth() - baseline);
                throw new Error('synchronous failure');
              },
              {key: `key-${k}`}
            )
          )
        );
      }
    }

    await settleAll(clock, calls);
    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
    return deepest;
  }

  it('stack depth is independent of the number of keys', async () => {
    const small = await measureDepth(20, 4);
    const large = await measureDepth(1_000, 4);

    // The same, not merely similar. If a guard were removed, `large` would be
    // roughly 50x `small`.
    expect(large).toBe(small);
  });

  it('stack depth is independent of the number of calls on one key', async () => {
    const few = await measureDepth(1, 50);
    const many = await measureDepth(1, 5_000);

    expect(many).toBe(few);
  });

  it('survives a large synchronous-failure storm across many keys', async () => {
    const clock = createVirtualClock(0);
    const limiter = createLimiter({constraints: generous, clock, maxConcurrent: 1});
    let invoked = 0;

    const calls = Array.from({length: 5_000}, (_, index) =>
      ignore(
        limiter.run(
          () => {
            invoked++;
            throw new Error('synchronous failure');
          },
          {key: `key-${index}`}
        )
      )
    );

    await settleAll(clock, calls);

    expect(invoked).toBe(5_000);
    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
    expect(clock.pendingTimers()).toBe(0);
  });

  it('survives a storm where every call also retries', async () => {
    const clock = createVirtualClock(0);
    const limiter = createLimiter({constraints: generous, clock, maxConcurrent: 2});
    let attempts = 0;

    const calls = Array.from({length: 1_500}, (_, index) =>
      ignore(
        limiter.run(
          () => {
            attempts++;
            throw new Error('synchronous failure');
          },
          {key: `key-${index % 250}`, retry: alwaysRetry(3, 1)}
        )
      )
    );

    await settleAll(clock, calls);

    expect(attempts).toBe(1_500 * 3);
    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
  });

  it('stays flat when a telemetry listener submits work on every event', async () => {
    // The one path that could plausibly nest: a listener re-entering the
    // limiter. The emitter's buffering keeps it at one level.
    const clock = createVirtualClock(0);
    const baseline = stackDepth();
    let deepest = 0;
    let nested = 0;

    const limiter = createLimiter({
      constraints: generous,
      clock,
      maxConcurrent: 1,
      onDecision: (event) => {
        if (event.kind === 'admitted' && nested < 500) {
          nested++;
          void ignore(
            limiter.run(
              () => {
                throw new Error('nested');
              },
              {key: `nested-${nested}`}
            )
          );
        }
      },
    });

    const calls = Array.from({length: 200}, (_, index) =>
      ignore(
        limiter.run(
          () => {
            deepest = Math.max(deepest, stackDepth() - baseline);
            throw new Error('outer');
          },
          {key: `outer-${index}`}
        )
      )
    );

    await settleAll(clock, calls);

    expect(nested).toBe(500);
    // A generous ceiling: the point is that 700 calls do not produce hundreds
    // of frames. Measured depth is a small constant.
    expect(deepest).toBeLessThan(60);
    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
  });
});

describe('stress — what bounds accepted work', () => {
  /**
   * `maxQueueDepth` bounds NEW INTAKE. It does not bound accepted calls, and
   * these tests pin the two ways that shows up.
   *
   * See docs/GUARANTEES.md, "What bounds accepted work", for the formula and
   * the backpressure recipe.
   */

  it('refuses new intake once the queue is at its bound', async () => {
    // The bound does work, on the thing it is for.
    const clock = createVirtualClock(0);
    const limiter = createLimiter({
      constraints: [{name: 'slow', limit: 1, interval: 'minute', burst: 1}],
      clock,
      maxQueueDepth: 4,
    });

    // Settled outcomes are collected as the calls finish, so the clock can be
    // driven afterwards — the queued ones each wait a minute of virtual time.
    const outcomes: string[] = [];
    const calls = Array.from({length: 50}, () =>
      limiter.run(() => 'x', {key: 'hot'}).then(
        () => void outcomes.push('ok'),
        (error: unknown) => void outcomes.push((error as Error).name)
      )
    );

    await settleAll(clock, calls);

    // One running, four queued, the remaining 45 refused at the door.
    expect(outcomes.filter((o) => o === 'LimiterQueueFullError')).toHaveLength(45);
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(5);
  });

  it('a retry re-enters PAST the bound, so the queue can exceed it', async () => {
    // Deliberate (D38): the bound governs new intake, and a retrying call was
    // already accepted. The consequence is measured here rather than implied.
    const clock = createVirtualClock(0);
    const limiter = createLimiter({
      constraints: [{name: 'slow', limit: 2, interval: 'second', burst: 2}],
      clock,
      maxConcurrent: 2,
      maxQueueDepth: 2,
    });

    let peakQueued = 0;
    const sample = (): void => {
      peakQueued = Math.max(peakQueued, limiter.stats().queued);
    };

    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i++) {
      calls.push(
        ignore(
          limiter
            .run(
              () => {
                sample();
                throw new Error('throttled');
              },
              {key: 'hot', retry: alwaysRetry(3, 50)}
            )
            .finally(sample)
        )
      );
      sample();
      await clock.advance(25);
      sample();
    }

    for (let step = 0; step < 40; step++) {
      await clock.advance(50);
      sample();
    }
    await settleAll(clock, calls);

    // The measured overshoot. If this ever reads <= 2 the bypass was removed,
    // which would be a behaviour change worth noticing.
    expect(peakQueued).toBeGreaterThan(2);
    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
  });

  it('accepted-unsettled work is not bounded by maxQueueDepth', async () => {
    // A backing-off call holds no queue entry, so it frees its slot for new
    // intake while still being accepted work the limiter is tracking.
    const clock = createVirtualClock(0);
    const limiter = createLimiter({
      constraints: [{name: 'p', limit: 1_000, interval: 'second', burst: 100}],
      clock,
      maxConcurrent: 10,
      maxQueueDepth: 2,
    });

    let peakAccepted = 0;
    const calls: Promise<unknown>[] = [];

    for (let i = 0; i < 40; i++) {
      calls.push(
        ignore(
          limiter.run(
            () => {
              throw new Error('throttled');
            },
            {key: 'hot', retry: alwaysRetry(3, 400)}
          )
        )
      );
      await clock.advance(5);
      const stats = limiter.stats();
      peakAccepted = Math.max(peakAccepted, stats.queued + stats.inflight + stats.backingOff);
    }

    for (let step = 0; step < 30; step++) await clock.advance(200);
    await settleAll(clock, calls);

    // Several times the queue bound of 2, held in the backing-off state.
    expect(peakAccepted).toBeGreaterThan(5);
    // And it all drains: accumulation is bounded, not leaked.
    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
    expect(clock.pendingTimers()).toBe(0);
  });

  it('onSaturated: reject is the backpressure that DOES bound acceptance', async () => {
    // The documented recipe. A rejecting caller never accumulates, because it
    // is refused rather than queued.
    const clock = createVirtualClock(0);
    const limiter = createLimiter({
      constraints: [{name: 'slow', limit: 1, interval: 'minute', burst: 1}],
      clock,
      maxQueueDepth: 100,
    });

    const first = limiter.run(() => 'got-it', {key: 'hot'});
    await settleAll(clock, [first]);

    const outcomes = await Promise.all(
      Array.from({length: 100}, () =>
        limiter
          .run(() => 'x', {key: 'hot', onSaturated: 'reject'})
          .then(() => 'ok', () => 'refused')
      )
    );

    expect(outcomes.filter((o) => o === 'refused')).toHaveLength(100);
    // Nothing accumulated at all, despite a queue bound of 100.
    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
  });
});
