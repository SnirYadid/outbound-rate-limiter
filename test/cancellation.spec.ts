/**
 * Cancellation, in all five states a call can be in.
 *
 * Two guarantees are checked everywhere below, because they are the ones a
 * rate limiter cannot get wrong:
 *
 *   - Cancelling BEFORE an attempt starts consumes no rate capacity.
 *   - Cancelling AFTER one starts refunds nothing. The request was sent.
 *
 * And one that is easy to state but needs races to prove: each logical call
 * settles exactly once, however abort, timeout, retry and task completion
 * interleave.
 */

import {describe, expect, it} from 'vitest';

import {
  LimiterAbortError,
  LimiterConfigError,
  LimiterTimeoutError,
} from '../src/errors.js';
import {createLimiter} from '../src/limiter.js';
import type {RateConstraint, RetryPolicy} from '../src/types.js';
import {deferred, ignore} from './harness/deferred.js';
import {settleAll} from './harness/settle.js';
import {createVirtualClock} from './harness/virtual-clock.js';

const paced: RateConstraint[] = [{name: 'paced', limit: 10, interval: 'second', burst: 1}];
const plenty: RateConstraint[] = [{name: 'plenty', limit: 10_000, interval: 'second'}];
const tenPerSecond: RateConstraint[] = [{name: 'per-second', limit: 10, interval: 'second'}];

function build(constraints: RateConstraint[] = plenty, extra: Record<string, unknown> = {}) {
  const clock = createVirtualClock(0);
  return {clock, limiter: createLimiter({constraints, clock, ...extra})};
}

const fixed = (maxAttempts: number, delayMs: number, extra: Partial<RetryPolicy> = {}): RetryPolicy => ({
  maxAttempts,
  jitter: 'none',
  baseDelayMs: delayMs,
  maxDelayMs: delayMs,
  classify: () => ({retry: true}),
  ...extra,
});

/** Reads the rejection off a cancelled call. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to be cancelled, but it resolved');
}

describe('cancellation — validation and the pre-aborted case', () => {
  it('rejects something that is not an AbortSignal', () => {
    const {limiter} = build();
    expect(() =>
      limiter.run(() => 'x', {signal: {} as AbortSignal})
    ).toThrow(LimiterConfigError);
  });

  it('refuses an already-aborted signal without creating a partition', async () => {
    const {limiter} = build(tenPerSecond);
    const controller = new AbortController();
    controller.abort();

    const call = limiter.run(() => 'never', {key: 'k', signal: controller.signal});
    await expect(call).rejects.toBeDefined();

    // No partition, so no capacity was reserved and no key was tracked — a
    // doomed call must not consume either.
    expect(limiter.stats().keys).toBe(0);
    expect(limiter.inspect('k').tracked).toBe(false);
  });

  it('never invokes the task for a pre-aborted signal', async () => {
    const {limiter} = build();
    const controller = new AbortController();
    controller.abort();
    let ran = false;

    await ignore(
      limiter.run(
        () => {
          ran = true;
          return 'x';
        },
        {signal: controller.signal}
      )
    );

    expect(ran).toBe(false);
  });

  it('rethrows the signal’s own reason, for fetch interoperability', async () => {
    const {limiter} = build();
    const reason = new Error('caller changed their mind');
    const controller = new AbortController();
    controller.abort(reason);

    expect(await rejection(limiter.run(() => 'x', {signal: controller.signal}))).toBe(reason);
  });

  it('falls back to LimiterAbortError when the signal carries no reason', async () => {
    // A hand-rolled signal, as an older runtime or a shim might provide.
    const {clock, limiter} = build();
    const listeners: (() => void)[] = [];
    const fake = {
      aborted: false,
      reason: undefined,
      addEventListener: (_type: string, handler: () => void) => void listeners.push(handler),
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;

    const gate = deferred();
    const call = limiter.run(() => gate.promise, {key: 'k', signal: fake});
    void call.catch(() => undefined);

    // Dispatched twice. This shim's `removeEventListener` is a no-op, so the
    // handler is still attached after the call has settled — which is exactly
    // the case the already-settled guard exists for.
    for (const handler of listeners) handler();
    for (const handler of listeners) handler();

    const error = await rejection(call);
    expect(error).toBeInstanceOf(LimiterAbortError);
    expect((error as Error).name).toBe('AbortError');
    expect(limiter.stats()).toMatchObject({inflight: 0, queued: 0, backingOff: 0});

    gate.resolve();
    await clock.flush();
  });
});

describe('cancellation — while queued', () => {
  it('removes the call from the queue and consumes no capacity', async () => {
    const {clock, limiter} = build(tenPerSecond, {maxConcurrent: 1});
    const gate = deferred();
    const controller = new AbortController();

    const holder = limiter.run(() => gate.promise, {key: 'k'});
    const queued = limiter.run(() => 'never', {key: 'k', signal: controller.signal});
    void queued.catch(() => undefined);

    expect(limiter.stats().queued).toBe(1);
    const before = limiter.inspect('k').constraints[0]!.available;

    controller.abort();

    await expect(queued).rejects.toBeDefined();
    expect(limiter.stats().queued).toBe(0);
    // The cancelled call never ran, so it must not have spent a token.
    expect(limiter.inspect('k').constraints[0]!.available).toBe(before);

    gate.resolve();
    await settleAll(clock, [holder]);
  });

  it('does not delay the calls behind it', async () => {
    const {clock, limiter} = build(paced);
    const order: string[] = [];
    const controller = new AbortController();

    const first = limiter.run(() => void order.push('first'), {key: 'k'});
    const doomed = limiter.run(() => void order.push('doomed'), {
      key: 'k',
      signal: controller.signal,
    });
    void doomed.catch(() => undefined);
    const third = limiter.run(() => void order.push('third'), {key: 'k'});

    controller.abort();
    await settleAll(clock, [first, third]);

    // 'third' moves up: it runs at the second pacing slot, not the third.
    expect(order).toEqual(['first', 'third']);
  });

  it('cancels a stale rate wake so the next head is not over-delayed', async () => {
    const {clock, limiter} = build(
      [{name: 'wide', limit: 10, interval: 'second', burst: 10}],
      {}
    );
    const controller = new AbortController();
    const startedAt: number[] = [];

    // Drain the bucket, then queue an expensive call (needs 10 tokens = 1s)
    // followed by a cheap one (needs 1 token = 100ms).
    const drain = limiter.run(() => void startedAt.push(clock.now()), {key: 'k', cost: 10});
    await settleAll(clock, [drain]);

    const expensive = limiter.run(() => void startedAt.push(clock.now()), {
      key: 'k',
      cost: 10,
      signal: controller.signal,
    });
    void expensive.catch(() => undefined);
    const cheap = limiter.run(() => void startedAt.push(clock.now()), {key: 'k', cost: 1});

    // The pump is asleep for 1000ms on the expensive head.
    expect(clock.nextTimerAt()).toBe(1_000);

    controller.abort();
    await expect(expensive).rejects.toBeDefined();

    await settleAll(clock, [cheap]);
    // If the stale wake had been kept, 'cheap' would have waited the full
    // second instead of the 100ms it actually needs.
    expect(startedAt).toEqual([0, 100]);
  });

  it('leaves no deadline timer behind', async () => {
    const {clock, limiter} = build(paced);
    const controller = new AbortController();

    const holder = limiter.run(() => 'first', {key: 'k'});
    await settleAll(clock, [holder]);

    const queued = limiter.run(() => 'never', {
      key: 'k',
      signal: controller.signal,
      totalBudgetMs: 10_000,
    });
    void queued.catch(() => undefined);
    expect(clock.pendingTimers()).toBeGreaterThan(0);

    controller.abort();
    await expect(queued).rejects.toBeDefined();

    expect(clock.pendingTimers()).toBe(0);
  });
});

describe('cancellation — while blocked on concurrency', () => {
  it('cancels a call waiting for a global slot', async () => {
    const {clock, limiter} = build(plenty, {maxConcurrent: 1});
    const gate = deferred();
    const controller = new AbortController();

    const holder = limiter.run(() => gate.promise, {key: 'a'});
    const waiting = limiter.run(() => 'never', {key: 'b', signal: controller.signal});
    void waiting.catch(() => undefined);

    controller.abort();
    await expect(waiting).rejects.toBeDefined();

    // The slot was never taken by the cancelled call, so the holder still has
    // it and the limiter is not over-committed.
    expect(limiter.stats().inflight).toBe(1);

    gate.resolve();
    await settleAll(clock, [holder]);
    expect(limiter.stats().inflight).toBe(0);
  });

  it('cancels a call waiting on its own key’s concurrency cap', async () => {
    const {clock, limiter} = build(plenty, {maxConcurrentPerKey: 1});
    const gate = deferred();
    const controller = new AbortController();

    const holder = limiter.run(() => gate.promise, {key: 'k'});
    const waiting = limiter.run(() => 'never', {key: 'k', signal: controller.signal});
    void waiting.catch(() => undefined);

    controller.abort();
    await expect(waiting).rejects.toBeDefined();
    expect(limiter.stats().queued).toBe(0);

    gate.resolve();
    await settleAll(clock, [holder]);
  });
});

describe('cancellation — while sleeping in backoff', () => {
  it('cancels the backoff and releases the partition claim', async () => {
    const {clock, limiter} = build();
    const controller = new AbortController();
    let attempts = 0;

    const call = limiter.run(
      () => {
        attempts++;
        throw new Error('again');
      },
      {key: 'k', signal: controller.signal, retry: fixed(5, 1_000)}
    );
    void call.catch(() => undefined);

    await clock.flush();
    expect(attempts).toBe(1);
    expect(limiter.stats().backingOff).toBe(1);

    controller.abort();

    await expect(call).rejects.toBeDefined();
    // The claim is released, so the partition is no longer pinned...
    expect(limiter.stats().backingOff).toBe(0);
    // ...and the backoff timer is gone, so nothing re-queues a settled call.
    expect(clock.pendingTimers()).toBe(0);

    await clock.advance(5_000);
    expect(attempts).toBe(1);
    expect(limiter.stats().queued).toBe(0);
  });

  it('lets the partition be evicted afterwards, but not before', async () => {
    const {clock, limiter} = build(paced, {sweepIntervalMs: 0, maxKeys: 100});
    const controller = new AbortController();

    const call = limiter.run(
      () => {
        throw new Error('again');
      },
      {key: 'k', signal: controller.signal, retry: fixed(5, 2_000)}
    );
    void call.catch(() => undefined);
    await clock.flush();

    // While sleeping, a sweep must not take it.
    await clock.advance(1_000);
    const probe = limiter.run(() => 'x', {key: 'probe-1'});
    await settleAll(clock, [probe]);
    expect(limiter.inspect('k').tracked).toBe(true);

    controller.abort();
    await expect(call).rejects.toBeDefined();

    // Once cancelled and recovered, it is disposable like any idle key.
    await clock.advance(1_000);
    const probe2 = limiter.run(() => 'x', {key: 'probe-2'});
    await settleAll(clock, [probe2]);
    expect(limiter.inspect('k').tracked).toBe(false);
  });

  it('does not refund the capacity the failed attempt spent', async () => {
    const {clock, limiter} = build([{name: 'c', limit: 60, interval: 'minute', burst: 10}]);
    const controller = new AbortController();

    const call = limiter.run(
      () => {
        throw new Error('again');
      },
      {key: 'k', signal: controller.signal, retry: fixed(5, 5_000)}
    );
    void call.catch(() => undefined);
    await clock.flush();

    const spent = limiter.inspect('k').constraints[0]!.available;
    expect(spent).toBeLessThan(10);

    controller.abort();
    await expect(call).rejects.toBeDefined();

    // Cancelling does not undo a request that was already sent.
    expect(limiter.inspect('k').constraints[0]!.available).toBe(spent);
  });
});

describe('cancellation — while an attempt is running', () => {
  it('aborts the attempt’s own signal so the task can stop', async () => {
    const {clock, limiter} = build();
    const controller = new AbortController();
    let innerAborted = false;

    const call = limiter.run(
      ({signal}) => {
        signal.addEventListener('abort', () => {
          innerAborted = true;
        });
        return new Promise<string>(() => undefined);
      },
      {key: 'k', signal: controller.signal}
    );
    void call.catch(() => undefined);

    expect(innerAborted).toBe(false);
    controller.abort();

    await expect(call).rejects.toBeDefined();
    expect(innerAborted).toBe(true);
    await clock.flush();
  });

  it('releases the concurrency slot immediately, exactly once', async () => {
    const {clock, limiter} = build(plenty, {maxConcurrent: 1});
    const controller = new AbortController();

    const cancelled = limiter.run(() => new Promise<string>(() => undefined), {
      key: 'a',
      signal: controller.signal,
    });
    void cancelled.catch(() => undefined);
    expect(limiter.stats().inflight).toBe(1);

    controller.abort();
    await expect(cancelled).rejects.toBeDefined();

    // Freed at once, not when the abandoned task eventually settles.
    expect(limiter.stats().inflight).toBe(0);
    const next = limiter.run(() => 'proceeds', {key: 'b'});
    await settleAll(clock, [next]);
    await expect(next).resolves.toBe('proceeds');
    expect(limiter.stats().inflight).toBe(0);
  });

  it('does NOT refund the capacity the attempt spent', async () => {
    const {clock, limiter} = build(tenPerSecond);
    const controller = new AbortController();

    const call = limiter.run(() => new Promise<string>(() => undefined), {
      key: 'k',
      cost: 4,
      signal: controller.signal,
    });
    void call.catch(() => undefined);
    expect(limiter.inspect('k').constraints[0]!.available).toBe(6);

    controller.abort();
    await expect(call).rejects.toBeDefined();

    expect(limiter.inspect('k').constraints[0]!.available).toBe(6);
    await clock.flush();
  });

  it('ignores a task that resolves after being cancelled', async () => {
    const {clock, limiter} = build();
    const controller = new AbortController();
    const gate = deferred<string>();

    const call = limiter.run(() => gate.promise, {key: 'k', signal: controller.signal});
    void call.catch(() => undefined);

    controller.abort();
    const error = await rejection(call);

    // A task that ignores its signal may keep running and finish later. The
    // caller has already been answered, and that answer stands.
    gate.resolve('completed anyway');
    await clock.flush();

    expect(await rejection(call)).toBe(error);
  });

  it('ignores a task that rejects after being cancelled, with no unhandled rejection', async () => {
    const {clock, limiter} = build();
    const controller = new AbortController();
    const gate = deferred<string>();

    const call = limiter.run(() => gate.promise, {key: 'k', signal: controller.signal});
    void call.catch(() => undefined);

    controller.abort();
    await expect(call).rejects.toBeDefined();

    gate.reject(new Error('late failure nobody asked about'));
    await clock.flush();

    expect(limiter.stats()).toMatchObject({inflight: 0, queued: 0, backingOff: 0});
  });

  it('stops a retry sequence rather than continuing it', async () => {
    const {clock, limiter} = build();
    const controller = new AbortController();
    let attempts = 0;

    const call = limiter.run(
      () => {
        attempts++;
        throw new Error('again');
      },
      {key: 'k', signal: controller.signal, retry: fixed(10, 100)}
    );
    void call.catch(() => undefined);

    await clock.advance(250);
    const seenSoFar = attempts;
    expect(seenSoFar).toBeGreaterThan(1);

    controller.abort();
    await expect(call).rejects.toBeDefined();

    await clock.advance(5_000);
    expect(attempts).toBe(seenSoFar);
  });
});

describe('cancellation — same-timestamp races', () => {
  it('abort and attempt timeout at the same instant settle once', async () => {
    const {clock, limiter} = build();
    const controller = new AbortController();

    const call = limiter.run(() => new Promise<string>(() => undefined), {
      key: 'k',
      signal: controller.signal,
      attemptTimeoutMs: 100,
    });
    void call.catch(() => undefined);

    // Abort scheduled for the very instant the timeout is due.
    clock.setTimer(() => controller.abort(), 100);
    await clock.advance(100);

    const error = await rejection(call);
    // Whichever won, the call settled exactly once and the books balance.
    expect(error).toBeDefined();
    expect(limiter.stats()).toMatchObject({inflight: 0, queued: 0, backingOff: 0});
    expect(clock.pendingTimers()).toBe(0);
  });

  it('abort at the instant a backoff is due settles once and re-queues nothing', async () => {
    const {clock, limiter} = build();
    const controller = new AbortController();
    let attempts = 0;

    const call = limiter.run(
      () => {
        attempts++;
        throw new Error('again');
      },
      {key: 'k', signal: controller.signal, retry: fixed(5, 200)}
    );
    void call.catch(() => undefined);
    await clock.flush();
    expect(attempts).toBe(1);

    // The abort lands on the same tick the backoff timer is due. The backoff
    // timer was scheduled first, so it fires first and re-queues the call;
    // the abort then has to find it in the queue rather than in backoff.
    clock.setTimer(() => controller.abort(), 200);
    await clock.advance(200);

    await expect(call).rejects.toBeDefined();
    expect(limiter.stats()).toMatchObject({inflight: 0, queued: 0, backingOff: 0});
    expect(clock.pendingTimers()).toBe(0);
  });

  it('abort at the instant a budget deadline fires settles once', async () => {
    const {clock, limiter} = build(paced);
    const controller = new AbortController();

    const holder = limiter.run(() => 'first', {key: 'k'});
    await settleAll(clock, [holder]);

    const call = limiter.run(() => 'never', {
      key: 'k',
      signal: controller.signal,
      totalBudgetMs: 50,
    });
    void call.catch(() => undefined);

    clock.setTimer(() => controller.abort(), 50);
    await clock.advance(50);

    await expect(call).rejects.toBeDefined();
    expect(limiter.stats()).toMatchObject({inflight: 0, queued: 0, backingOff: 0});
    expect(clock.pendingTimers()).toBe(0);
  });

  it('a same-turn abort beats a resolution the call has not observed yet', async () => {
    // Worth pinning because it reads like a coin toss and is not. Resolving a
    // promise schedules its `.then` as a MICROTASK; `abort()` runs its
    // listener SYNCHRONOUSLY. So an abort issued in the same turn as the
    // resolution arrives first, and the call had genuinely not observed the
    // result yet when the caller changed its mind.
    const {clock, limiter} = build();
    const controller = new AbortController();
    const gate = deferred<string>();

    const call = limiter.run(() => gate.promise, {key: 'k', signal: controller.signal});
    void call.catch(() => undefined);

    gate.resolve('finished in time');
    controller.abort();
    await clock.flush();

    await expect(call).rejects.toBeDefined();
    expect(limiter.stats()).toMatchObject({inflight: 0, queued: 0, backingOff: 0});
  });

  it('an abort after the resolution has been observed does not override it', async () => {
    // The other side of the same coin: once the microtask has run, the call is
    // settled and a later abort is inert.
    const {clock, limiter} = build();
    const controller = new AbortController();
    const gate = deferred<string>();

    const call = limiter.run(() => gate.promise, {key: 'k', signal: controller.signal});

    gate.resolve('finished in time');
    await clock.flush(); // let the resolution land
    controller.abort();
    await clock.flush();

    await expect(call).resolves.toBe('finished in time');
    expect(limiter.stats()).toMatchObject({inflight: 0, queued: 0, backingOff: 0});
  });

  it('two aborts of the same signal settle the call once', async () => {
    const {clock, limiter} = build();
    const controller = new AbortController();

    const call = limiter.run(() => new Promise<string>(() => undefined), {
      key: 'k',
      signal: controller.signal,
    });
    void call.catch(() => undefined);

    controller.abort();
    controller.abort();
    controller.abort();

    await expect(call).rejects.toBeDefined();
    expect(limiter.stats()).toMatchObject({inflight: 0, queued: 0, backingOff: 0});
    await clock.flush();
  });
});

describe('cancellation — resource hygiene', () => {
  it('removes its abort listener, so a reused controller does not accumulate them', async () => {
    const {clock, limiter} = build();
    const controller = new AbortController();
    let listeners = 0;
    const realAdd = controller.signal.addEventListener.bind(controller.signal);
    const realRemove = controller.signal.removeEventListener.bind(controller.signal);
    Object.defineProperty(controller.signal, 'addEventListener', {
      value: (...args: Parameters<typeof realAdd>) => {
        listeners++;
        realAdd(...args);
      },
    });
    Object.defineProperty(controller.signal, 'removeEventListener', {
      value: (...args: Parameters<typeof realRemove>) => {
        listeners--;
        realRemove(...args);
      },
    });

    // One shared controller across many calls, which is how a request-scoped
    // signal is normally used.
    const calls = Array.from({length: 25}, (_, index) =>
      limiter.run(() => index, {key: 'k', signal: controller.signal})
    );
    await settleAll(clock, calls);

    // Every call registered one and removed one.
    expect(listeners).toBe(0);
  });

  it('a cancelled call leaves nothing outstanding', async () => {
    const {clock, limiter} = build(paced, {maxConcurrent: 2});
    const controllers = Array.from({length: 12}, () => new AbortController());

    const calls = controllers.map((controller, index) =>
      ignore(
        limiter.run(
          (ctx) => {
            if (ctx.attempt < 2) throw new Error('flaky');
            return new Promise<number>(() => undefined);
          },
          {
            key: `key-${index % 3}`,
            signal: controller.signal,
            retry: fixed(4, 150),
            totalBudgetMs: 5_000,
          }
        )
      )
    );

    await clock.advance(200);
    for (const controller of controllers) controller.abort();
    await settleAll(clock, calls);

    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
    expect(clock.pendingTimers()).toBe(0);
  });

  it('cancellation cannot create extra capacity', async () => {
    // The property that matters most. Cancelling repeatedly must never leave a
    // key able to admit more than its bound allows.
    const {clock, limiter} = build([{name: 'tight', limit: 2, interval: 'second', burst: 2}]);
    const admittedAt: number[] = [];

    for (let round = 0; round < 10; round++) {
      const controller = new AbortController();
      const call = limiter.run(
        () => {
          admittedAt.push(clock.now());
          return new Promise<void>(() => undefined);
        },
        {key: 'k', signal: controller.signal}
      );
      void call.catch(() => undefined);
      controller.abort();
      await expect(call).rejects.toBeDefined();
      await clock.advance(100);
    }

    // Each admitted attempt spent a token and none were refunded, so the
    // conservation bound must still hold across the whole run.
    for (let i = 0; i < admittedAt.length; i++) {
      for (let j = i; j < admittedAt.length; j++) {
        const consumed = j - i + 1;
        const windowMs = admittedAt[j]! - admittedAt[i]!;
        expect(consumed).toBeLessThanOrEqual(2 + 0.002 * windowMs + 1e-9);
      }
    }
  });

  it('an attempt gets a signal even when the caller supplied none', async () => {
    const {clock, limiter} = build();
    let seen: AbortSignal | undefined;

    const call = limiter.run((ctx) => {
      seen = ctx.signal;
      return 'ok';
    });
    await settleAll(clock, [call]);

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });

  it('aborts the attempt signal on an attempt timeout', async () => {
    const {clock, limiter} = build();
    let innerAborted = false;

    const call = limiter.run(
      ({signal}) => {
        signal.addEventListener('abort', () => {
          innerAborted = true;
        });
        return new Promise<string>(() => undefined);
      },
      {key: 'k', attemptTimeoutMs: 100}
    );
    void call.catch(() => undefined);

    await clock.advance(100);

    await expect(call).rejects.toThrow(LimiterTimeoutError);
    expect(innerAborted).toBe(true);
  });
});

describe('cancellation — a pre-aborted signal without a reason', () => {
  it('falls back to LimiterAbortError before the call is submitted', async () => {
    // A signal that is already aborted but carries no `reason`. A real
    // AbortController always supplies a DOMException, so this is the shape a
    // shim or an older runtime gives — and the one case where the fallback
    // error is what the caller sees.
    const {limiter} = build(tenPerSecond);
    const fake = {
      aborted: true,
      reason: undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;

    const error = await rejection(limiter.run(() => 'never', {key: 'k', signal: fake}));

    expect(error).toBeInstanceOf(LimiterAbortError);
    expect((error as Error).name).toBe('AbortError');
    expect((error as Error).message).toMatch(/before it was submitted/);
    // Still no partition: a doomed call reserves nothing.
    expect(limiter.stats().keys).toBe(0);
  });
});

describe('cancellation across nested limiters', () => {
  /**
   * Two limiters nested — the documented way to hold an account-wide ceiling
   * and a per-credential one at the same time (README, "A global limit *and*
   * a per-key limit").
   *
   * The trap: an `AbortSignal` on the outer `run` cancels the outer call and
   * nothing else. The inner limiter never learns about it, so it keeps holding
   * a concurrency slot for work that the caller has already been told was
   * cancelled. These tests pin BOTH arrangements, including the wrong one,
   * because the wrong one is what a reader will write first.
   */

  const plenty: RateConstraint[] = [{name: 'plenty', limit: 10_000, interval: 'second'}];

  it('does NOT reach the inner limiter when only the outer run is given the signal', async () => {
    const clock = createVirtualClock(0);
    const account = createLimiter({constraints: plenty, clock});
    const perCredential = createLimiter({constraints: plenty, clock});

    const controller = new AbortController();
    const gate = deferred<string>();
    let innerSettled = false;

    const call = ignore(
      perCredential.run(
        () =>
          account.run(async () => {
            const value = await gate.promise;
            innerSettled = true;
            return value;
          }),
        {key: 'cred-1', signal: controller.signal}
      )
    );

    await clock.flush();
    controller.abort();
    await clock.flush();

    // The caller has been answered...
    await expect(
      perCredential.run(() => 'probe', {key: 'other'})
    ).resolves.toBe('probe');
    // ...but the inner limiter is still holding a slot for live work.
    expect(account.stats().inflight).toBe(1);
    expect(innerSettled).toBe(false);

    gate.resolve('late');
    await settleAll(clock, [call]);
    expect(innerSettled).toBe(true);
    expect(account.stats().inflight).toBe(0);
  });

  it('stops the inner call when the signal is passed to both runs', async () => {
    const clock = createVirtualClock(0);
    const account = createLimiter({constraints: plenty, clock});
    const perCredential = createLimiter({constraints: plenty, clock});

    const controller = new AbortController();
    const gate = deferred<string>();
    let innerFinishedNormally = false;

    const call = ignore(
      perCredential.run(
        () =>
          account.run(
            async ({signal}) => {
              // Races the gate against the abort. If the abort wins — which is
              // the whole point — the gate branch never runs.
              const value = await Promise.race([
                gate.promise,
                new Promise<never>((_resolve, reject) => {
                  signal.addEventListener('abort', () => {
                    reject(signal.reason as Error);
                  });
                }),
              ]);
              innerFinishedNormally = true;
              return value;
            },
            {signal: controller.signal}
          ),
        {key: 'cred-1', signal: controller.signal}
      )
    );

    await clock.flush();
    controller.abort();
    await settleAll(clock, [call]);

    // The gate is still open, so a normal completion was genuinely possible —
    // the abort is what stopped it.
    gate.resolve('would have completed');
    await clock.flush();
    expect(innerFinishedNormally).toBe(false);
    // Both limiters are clean: the inner one released its slot with the abort.
    expect(account.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
    expect(perCredential.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
  });
});
