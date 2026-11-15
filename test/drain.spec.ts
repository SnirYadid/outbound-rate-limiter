/**
 * `drain()` — and the precise shape of what it promises.
 *
 * The contract, stated once so the tests below can be read against it:
 *
 *   drain() resolves when every call accepted BEFORE this invocation has
 *   settled, including their queued attempts and retry backoffs. It does not
 *   close the limiter and does not reject new work. Calls submitted after it
 *   begins are not part of that barrier. It never rejects.
 *
 * It is NOT a graceful-shutdown API. There is no `close()`, so a caller who
 * wants to stop accepting work must stop calling `run()` themselves.
 */

import {describe, expect, it} from 'vitest';

import {createLimiter} from '../src/limiter.js';
import type {RateConstraint, RetryPolicy} from '../src/types.js';
import {deferred, ignore} from './harness/deferred.js';
import {settleAll} from './harness/settle.js';
import {createVirtualClock} from './harness/virtual-clock.js';

const plenty: RateConstraint[] = [{name: 'plenty', limit: 10_000, interval: 'second'}];
const paced: RateConstraint[] = [{name: 'paced', limit: 10, interval: 'second', burst: 1}];

function build(constraints: RateConstraint[] = plenty, extra: Record<string, unknown> = {}) {
  const clock = createVirtualClock(0);
  return {clock, limiter: createLimiter({constraints, clock, ...extra})};
}

const fixed = (maxAttempts: number, delayMs: number): RetryPolicy => ({
  maxAttempts,
  jitter: 'none',
  baseDelayMs: delayMs,
  maxDelayMs: delayMs,
  classify: () => ({retry: true}),
});

/** Tracks whether a promise has settled, without awaiting it. */
function track(promise: Promise<unknown>): () => boolean {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    }
  );
  return () => done;
}

describe('drain — the empty and simple cases', () => {
  it('resolves immediately on an idle limiter', async () => {
    const {limiter} = build();
    await expect(limiter.drain()).resolves.toBeUndefined();
  });

  it('resolves immediately after everything has already settled', async () => {
    const {clock, limiter} = build();
    const call = limiter.run(() => 'ok');
    await settleAll(clock, [call]);

    await expect(limiter.drain()).resolves.toBeUndefined();
  });

  it('waits for one in-flight call', async () => {
    const {clock, limiter} = build();
    const gate = deferred<string>();
    const call = limiter.run(() => gate.promise, {key: 'k'});

    const drain = limiter.drain();
    const drained = track(drain);
    await clock.flush();
    expect(drained()).toBe(false);

    gate.resolve('done');
    await settleAll(clock, [call]);
    await drain;

    expect(drained()).toBe(true);
  });

  it('waits for queued calls, not just running ones', async () => {
    const {clock, limiter} = build(paced);
    const calls = Array.from({length: 4}, (_, index) => limiter.run(() => index, {key: 'k'}));

    const drain = limiter.drain();
    const drained = track(drain);
    await clock.flush();
    expect(drained()).toBe(false);
    expect(limiter.stats().queued).toBe(3);

    await settleAll(clock, [...calls, drain]);
    expect(drained()).toBe(true);
    expect(await Promise.all(calls)).toEqual([0, 1, 2, 3]);
  });
});

describe('drain — retries and backoffs', () => {
  it('waits through a retry backoff, which holds no queue entry or slot', async () => {
    // The state `drain()` would miss if it only looked at queues and slots.
    const {clock, limiter} = build();
    let attempts = 0;

    const call = limiter.run(
      () => {
        attempts++;
        if (attempts < 3) throw new Error('again');
        return 'eventually';
      },
      {key: 'k', retry: fixed(5, 500)}
    );

    await clock.flush();
    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 1});

    const drain = limiter.drain();
    const drained = track(drain);
    await clock.advance(400);
    expect(drained()).toBe(false);

    await settleAll(clock, [call, drain]);
    expect(drained()).toBe(true);
    expect(attempts).toBe(3);
    await expect(call).resolves.toBe('eventually');
  });

  it('does not resolve early when a call is between attempts', async () => {
    const {clock, limiter} = build();
    const states: string[] = [];

    const call = ignore(
      limiter.run(
        () => {
          states.push('attempt');
          throw new Error('always');
        },
        {key: 'k', retry: fixed(3, 200)}
      )
    );

    const drain = limiter.drain();
    void drain.then(() => states.push('drained'));

    await settleAll(clock, [call, drain]);

    // The drain resolved after the last attempt, never between them.
    expect(states).toEqual(['attempt', 'attempt', 'attempt', 'drained']);
  });
});

describe('drain — the barrier is a snapshot', () => {
  it('calls submitted after drain() begins do not extend it', async () => {
    const {clock, limiter} = build();
    const first = deferred<string>();
    const second = deferred<string>();

    const before = limiter.run(() => first.promise, {key: 'a'});
    const drain = limiter.drain();
    const drained = track(drain);

    // Submitted after the snapshot: this must not hold the barrier open.
    const after = limiter.run(() => second.promise, {key: 'b'});

    first.resolve('before');
    await clock.flush();
    await drain;
    expect(drained()).toBe(true);

    // ...and it is genuinely still running.
    expect(limiter.stats().inflight).toBe(1);
    second.resolve('after');
    await settleAll(clock, [before, after]);
  });

  it('does not reject or refuse new work while draining', async () => {
    const {clock, limiter} = build();
    const gate = deferred<string>();
    const holder = limiter.run(() => gate.promise, {key: 'a'});
    const drain = limiter.drain();

    // Not a shutdown: the limiter keeps accepting calls.
    await expect(limiter.run(() => 'accepted', {key: 'b'})).resolves.toBe('accepted');

    gate.resolve('x');
    await settleAll(clock, [holder, drain]);
  });

  it('repeated drains are independent', async () => {
    const {clock, limiter} = build();
    const first = deferred<string>();
    const second = deferred<string>();

    const a = limiter.run(() => first.promise, {key: 'a'});
    const drainA = limiter.drain();
    const drainedA = track(drainA);

    const b = limiter.run(() => second.promise, {key: 'b'});
    const drainB = limiter.drain();
    const drainedB = track(drainB);

    first.resolve('a');
    await clock.flush();
    await drainA;

    // The first barrier only ever covered 'a'.
    expect(drainedA()).toBe(true);
    expect(drainedB()).toBe(false);

    second.resolve('b');
    await settleAll(clock, [a, b, drainB]);
    expect(drainedB()).toBe(true);
  });

  it('overlapping drains both resolve', async () => {
    const {clock, limiter} = build();
    const gate = deferred<string>();
    const call = limiter.run(() => gate.promise, {key: 'k'});

    const drains = [limiter.drain(), limiter.drain(), limiter.drain()];
    gate.resolve('ok');
    await settleAll(clock, [call, ...drains]);

    await expect(Promise.all(drains)).resolves.toEqual([undefined, undefined, undefined]);
  });

  it('a drain started during a drain still covers only its own snapshot', async () => {
    const {clock, limiter} = build();
    const slow = deferred<string>();
    const fast = deferred<string>();

    const a = limiter.run(() => slow.promise, {key: 'a'});
    const outer = limiter.drain();

    const b = limiter.run(() => fast.promise, {key: 'b'});
    const inner = limiter.drain();
    const innerDone = track(inner);

    fast.resolve('b');
    await clock.flush();
    // 'inner' covers both a and b, so it must still be waiting on a.
    expect(innerDone()).toBe(false);

    slow.resolve('a');
    await settleAll(clock, [a, b, outer, inner]);
    expect(innerDone()).toBe(true);
  });
});

describe('drain — failures and cancellation', () => {
  it('never rejects, however the drained calls ended', async () => {
    const {clock, limiter} = build();
    const failing = ignore(
      limiter.run(() => {
        throw new Error('task failed');
      }, {key: 'a'})
    );
    const rejecting = ignore(
      limiter.run(async () => {
        throw new Error('async failure');
      }, {key: 'b'})
    );

    const drain = limiter.drain();
    await settleAll(clock, [failing, rejecting, drain]);

    // Reports that work finished, not whether it succeeded.
    await expect(drain).resolves.toBeUndefined();
  });

  it('a cancelled call releases the barrier', async () => {
    const {clock, limiter} = build();
    const controller = new AbortController();

    const call = ignore(
      limiter.run(() => new Promise<string>(() => undefined), {
        key: 'k',
        signal: controller.signal,
      })
    );
    const drain = limiter.drain();
    const drained = track(drain);

    await clock.flush();
    expect(drained()).toBe(false);

    controller.abort();
    await settleAll(clock, [call, drain]);

    expect(drained()).toBe(true);
  });

  it('a call cancelled mid-backoff releases the barrier', async () => {
    const {clock, limiter} = build();
    const controller = new AbortController();

    const call = ignore(
      limiter.run(
        () => {
          throw new Error('again');
        },
        {key: 'k', signal: controller.signal, retry: fixed(5, 5_000)}
      )
    );
    await clock.flush();
    expect(limiter.stats().backingOff).toBe(1);

    const drain = limiter.drain();
    const drained = track(drain);
    await clock.advance(100);
    expect(drained()).toBe(false);

    controller.abort();
    await settleAll(clock, [call, drain]);

    expect(drained()).toBe(true);
    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
  });

  it('a budget-expired call releases the barrier', async () => {
    const {clock, limiter} = build(paced);
    const holder = limiter.run(() => 'first', {key: 'k'});
    await settleAll(clock, [holder]);

    const doomed = ignore(limiter.run(() => 'never', {key: 'k', totalBudgetMs: 50}));
    const drain = limiter.drain();

    await settleAll(clock, [doomed, drain]);
    await expect(drain).resolves.toBeUndefined();
  });

  it('a refused call was never part of a later barrier', async () => {
    const {clock, limiter} = build(paced, {maxQueueDepth: 1});
    const running = limiter.run(() => 'a', {key: 'k'});
    const queued = ignore(limiter.run(() => 'b', {key: 'k'}));
    const refused = ignore(limiter.run(() => 'c', {key: 'k'}));
    await refused;

    const drain = limiter.drain();
    await settleAll(clock, [running, queued, drain]);
    await expect(drain).resolves.toBeUndefined();
  });
});

describe('drain — leaves nothing outstanding', () => {
  it('a drained limiter has no timers, queue entries or backoffs left', async () => {
    const {clock, limiter} = build([{name: 'paced', limit: 20, interval: 'second', burst: 4}], {
      maxConcurrent: 2,
    });

    const calls = Array.from({length: 20}, (_, index) =>
      ignore(
        limiter.run(
          (ctx) => {
            if (index % 4 === 0 && ctx.attempt < 2) throw new Error('flaky');
            return index;
          },
          {key: `key-${index % 3}`, retry: fixed(3, 60), totalBudgetMs: 30_000}
        )
      )
    );

    const drain = limiter.drain();
    await settleAll(clock, [...calls, drain]);

    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe('drain — refusals must not leak a live-call entry', () => {
  // Regression. The first draft of Day 5 added each call to the live set right
  // after building it, but the queue-full and saturated refusal paths rejected
  // the promise DIRECTLY instead of going through the call's settle. So the
  // call's internal `done` never resolved: `drain()` hung on a call that had
  // already been answered, and the live set grew by one entry per refusal.
  //
  // Both tests below hang rather than fail if that regresses, which is why the
  // virtual-clock harness reports a stall with a count instead of timing out.

  it('a queue-full refusal does not hold a later drain open', async () => {
    const {clock, limiter} = build(paced, {maxQueueDepth: 1});
    const running = limiter.run(() => 'a', {key: 'k'});
    const queued = ignore(limiter.run(() => 'b', {key: 'k'}));

    for (let i = 0; i < 5; i++) {
      await expect(limiter.run(() => 'refused', {key: 'k'})).rejects.toBeDefined();
    }

    const drain = limiter.drain();
    await settleAll(clock, [running, queued, drain]);
    await expect(drain).resolves.toBeUndefined();
  });

  it('a saturated refusal does not hold a later drain open', async () => {
    const {clock, limiter} = build(paced);
    const running = limiter.run(() => 'a', {key: 'k'});
    await settleAll(clock, [running]);

    for (let i = 0; i < 5; i++) {
      await expect(
        limiter.run(() => 'refused', {key: 'k', onSaturated: 'reject'})
      ).rejects.toBeDefined();
    }

    await expect(limiter.drain()).resolves.toBeUndefined();
  });

  it('refusals do not accumulate: many of them still drain promptly', async () => {
    const {clock, limiter} = build(paced, {maxQueueDepth: 1});
    const running = limiter.run(() => 'a', {key: 'k'});
    const queued = ignore(limiter.run(() => 'b', {key: 'k'}));

    for (let i = 0; i < 200; i++) {
      await expect(limiter.run(() => 'x', {key: 'k'})).rejects.toBeDefined();
    }

    const drain = limiter.drain();
    await settleAll(clock, [running, queued, drain]);
    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
  });
});
