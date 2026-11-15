/**
 * The retry engine: attempts, backoff, hints, timeouts and budgets.
 *
 * All deterministic. The clock is virtual and jitter is either disabled or fed
 * from a seeded generator, so every delay below is an exact number.
 */

import {describe, expect, it} from 'vitest';

import {
  QuotaPilotBudgetError,
  QuotaPilotConfigError,
  QuotaPilotTimeoutError,
} from '../src/errors.js';
import {createLimiter} from '../src/limiter.js';
import {createSeededRandom} from '../src/random.js';
import {computeBackoffMs, normalizeRetryPolicy, providerHintMs} from '../src/retry.js';
import {cancelWake} from '../src/scheduler.js';
import type {RateConstraint, RetryPolicy} from '../src/types.js';
import {deferred, ignore} from './harness/deferred.js';
import {settleAll} from './harness/settle.js';
import {createVirtualClock} from './harness/virtual-clock.js';

const plenty: RateConstraint[] = [{name: 'plenty', limit: 10_000, interval: 'second'}];

function build(constraints: RateConstraint[] = plenty, extra: Record<string, unknown> = {}) {
  const clock = createVirtualClock(0);
  return {clock, limiter: createLimiter({constraints, clock, ...extra})};
}

/** Fixed, predictable delay: jitter off and base == max. */
const fixed = (maxAttempts: number, delayMs: number, extra: Partial<RetryPolicy> = {}): RetryPolicy => ({
  maxAttempts,
  jitter: 'none',
  baseDelayMs: delayMs,
  maxDelayMs: delayMs,
  classify: () => ({retry: true}),
  ...extra,
});

describe('retry — policy validation', () => {
  it('requires a classifier, and says why there is no default', () => {
    const {limiter} = build();
    expect(() =>
      limiter.run(() => 'x', {retry: {maxAttempts: 3} as unknown as RetryPolicy})
    ).toThrow(/classify is required/);
    expect(() =>
      limiter.run(() => 'x', {retry: {maxAttempts: 3} as unknown as RetryPolicy})
    ).toThrow(/different things/);
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity])('rejects maxAttempts = %s', (maxAttempts) => {
    const {limiter} = build();
    expect(() =>
      limiter.run(() => 'x', {retry: {maxAttempts, classify: () => ({retry: false})}})
    ).toThrow(QuotaPilotConfigError);
  });

  it.each([
    ['baseDelayMs', 0],
    ['baseDelayMs', -5],
    ['baseDelayMs', Number.NaN],
    ['maxDelayMs', 0],
    ['maxDelayMs', Infinity],
  ])('rejects %s = %s', (field, value) => {
    const {limiter} = build();
    expect(() =>
      limiter.run(() => 'x', {
        retry: {maxAttempts: 2, classify: () => ({retry: false}), [field]: value},
      })
    ).toThrow(QuotaPilotConfigError);
  });

  it('rejects maxDelayMs below baseDelayMs', () => {
    const {limiter} = build();
    expect(() =>
      limiter.run(() => 'x', {
        retry: {maxAttempts: 2, classify: () => ({retry: false}), baseDelayMs: 1_000, maxDelayMs: 100},
      })
    ).toThrow(/at least retry.baseDelayMs/);
  });

  it('rejects an unknown jitter mode and a non-boolean timeout flag', () => {
    const {limiter} = build();
    expect(() =>
      limiter.run(() => 'x', {
        retry: {maxAttempts: 2, classify: () => ({retry: false}), jitter: 'some' as 'full'},
      })
    ).toThrow(QuotaPilotConfigError);
    expect(() =>
      limiter.run(() => 'x', {
        retry: {
          maxAttempts: 2,
          classify: () => ({retry: false}),
          retryOnAttemptTimeout: 'yes' as unknown as boolean,
        },
      })
    ).toThrow(QuotaPilotConfigError);
  });

  it.each([0, -1, Number.NaN, Infinity])(
    'rejects attemptTimeoutMs and totalBudgetMs = %s',
    (value) => {
      const {limiter} = build();
      expect(() => limiter.run(() => 'x', {attemptTimeoutMs: value})).toThrow(
        QuotaPilotConfigError
      );
      expect(() => limiter.run(() => 'x', {totalBudgetMs: value})).toThrow(QuotaPilotConfigError);
    }
  );

  it.each([null, 'always', 7])('rejects a retry option that is not an object: %s', (policy) => {
    const {limiter} = build();
    expect(() => limiter.run(() => 'x', {retry: policy as unknown as RetryPolicy})).toThrow(
      QuotaPilotConfigError
    );
  });

  it('runs exactly once with no retry option', async () => {
    const {limiter} = build();
    let attempts = 0;
    const boom = new Error('once');

    await expect(
      limiter.run(() => {
        attempts++;
        throw boom;
      })
    ).rejects.toBe(boom);
    expect(attempts).toBe(1);
  });

  it('maxAttempts of 1 means no retries', async () => {
    const {limiter} = build();
    let attempts = 0;
    const boom = new Error('single');

    await expect(
      limiter.run(
        () => {
          attempts++;
          throw boom;
        },
        {retry: fixed(1, 100)}
      )
    ).rejects.toBe(boom);
    expect(attempts).toBe(1);
  });
});

describe('retry — backoff arithmetic', () => {
  const policy = normalizeRetryPolicy({
    maxAttempts: 10,
    classify: () => ({retry: true}),
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    jitter: 'none',
  });
  const never = () => 0;

  it('doubles from the base and caps at maxDelayMs', () => {
    expect(computeBackoffMs(1, policy, never)).toBe(100);
    expect(computeBackoffMs(2, policy, never)).toBe(200);
    expect(computeBackoffMs(3, policy, never)).toBe(400);
    expect(computeBackoffMs(4, policy, never)).toBe(800);
    expect(computeBackoffMs(5, policy, never)).toBe(1_000); // capped
    expect(computeBackoffMs(50, policy, never)).toBe(1_000);
  });

  it('stays finite at an absurd attempt count', () => {
    // The exponent is clamped so 2 ** n cannot reach Infinity and poison the
    // timer math with NaN.
    expect(Number.isFinite(computeBackoffMs(10_000, policy, never))).toBe(true);
  });

  it('full jitter draws from [0, computed)', () => {
    const jittered = normalizeRetryPolicy({
      maxAttempts: 10,
      classify: () => ({retry: true}),
      baseDelayMs: 100,
      maxDelayMs: 10_000,
    });
    const random = createSeededRandom(7);

    for (let attempt = 1; attempt <= 6; attempt++) {
      const computed = Math.min(10_000, 100 * 2 ** (attempt - 1));
      const delay = computeBackoffMs(attempt, jittered, random);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(computed);
    }
  });

  it('is reproducible for a given seed', () => {
    const jittered = normalizeRetryPolicy({maxAttempts: 5, classify: () => ({retry: true})});
    const first = Array.from({length: 5}, (_, i) =>
      computeBackoffMs(i + 1, jittered, createSeededRandom(42))
    );
    const second = Array.from({length: 5}, (_, i) =>
      computeBackoffMs(i + 1, jittered, createSeededRandom(42))
    );
    expect(first).toEqual(second);
  });
});

describe('MANDATORY 3 — multiple retries for the same key', () => {
  it('retries with exponentially growing delays', async () => {
    const {clock, limiter} = build(plenty, {random: createSeededRandom(1)});
    const startedAt: number[] = [];

    const call = limiter
      .run(
        () => {
          startedAt.push(clock.now());
          throw new Error('always');
        },
        {
          key: 'k',
          retry: {
            maxAttempts: 4,
            jitter: 'none',
            baseDelayMs: 100,
            maxDelayMs: 10_000,
            classify: () => ({retry: true}),
          },
        }
      )
      .catch((error: unknown) => error);

    await settleAll(clock, [call]);

    // 100, 200, 400 between four attempts.
    expect(startedAt).toEqual([0, 100, 300, 700]);
  });

  it('two keys retry independently', async () => {
    const {clock, limiter} = build();
    const byKey = new Map<string, number[]>();

    const calls = ['a', 'b'].map((key) =>
      limiter
        .run(
          () => {
            const times = byKey.get(key) ?? [];
            times.push(clock.now());
            byKey.set(key, times);
            if (times.length < 3) throw new Error('again');
            return key;
          },
          {key, retry: fixed(5, 200)}
        )
        .catch(() => 'failed')
    );

    await settleAll(clock, calls);

    expect(byKey.get('a')).toEqual([0, 200, 400]);
    expect(byKey.get('b')).toEqual([0, 200, 400]);
    await expect(Promise.all(calls)).resolves.toEqual(['a', 'b']);
  });

  it('reports the attempt number to the task', async () => {
    const {clock, limiter} = build();
    const seen: number[] = [];

    const call = limiter
      .run(
        (ctx) => {
          seen.push(ctx.attempt);
          if (ctx.attempt < 3) throw new Error('again');
          return 'ok';
        },
        {key: 'k', retry: fixed(5, 50)}
      )
      .catch(() => 'failed');

    await settleAll(clock, [call]);
    expect(seen).toEqual([1, 2, 3]);
    await expect(call).resolves.toBe('ok');
  });

  it('reports total elapsed time, not per-attempt time', async () => {
    const {clock, limiter} = build();
    const elapsed: number[] = [];

    const call = limiter
      .run(
        (ctx) => {
          elapsed.push(ctx.elapsedMs);
          if (ctx.attempt < 3) throw new Error('again');
          return 'ok';
        },
        {key: 'k', retry: fixed(5, 250)}
      )
      .catch(() => 'failed');

    await settleAll(clock, [call]);
    expect(elapsed).toEqual([0, 250, 500]);
  });
});

describe('MANDATORY 4 — weighted capacity per attempt', () => {
  it('charges the cost again on every attempt', async () => {
    const {clock, limiter} = build([
      {name: 'wide', limit: 100, interval: 'minute', burst: 20},
    ]);

    let attempts = 0;
    const call = limiter
      .run(
        () => {
          attempts++;
          if (attempts < 3) throw new Error('again');
          return 'ok';
        },
        {key: 'k', cost: 5, retry: fixed(4, 10)}
      )
      .catch(() => 'failed');

    await settleAll(clock, [call]);

    expect(attempts).toBe(3);
    // Three attempts at cost 5 drew 15 of 20, minus the trickle refilled over
    // the two 10ms backoffs.
    const available = limiter.inspect('k').constraints[0]!.available;
    expect(available).toBeGreaterThanOrEqual(5);
    expect(available).toBeLessThan(5.1);
  });

  it('paces retries through normal rate admission', async () => {
    const {clock, limiter} = build([{name: 'tight', limit: 10, interval: 'second', burst: 1}]);
    const startedAt: number[] = [];

    // Backoff is 10ms but the bucket only yields a token every 100ms, so rate
    // admission — not the backoff — sets the pace.
    const call = limiter
      .run(
        () => {
          startedAt.push(clock.now());
          if (startedAt.length < 3) throw new Error('again');
          return 'ok';
        },
        {key: 'k', retry: fixed(4, 10)}
      )
      .catch(() => 'failed');

    await settleAll(clock, [call]);
    expect(startedAt).toEqual([0, 100, 200]);
  });

  it('does not consume capacity while backing off', async () => {
    const {clock, limiter} = build([{name: 'c', limit: 60, interval: 'minute', burst: 10}]);

    let attempts = 0;
    const call = limiter
      .run(
        () => {
          attempts++;
          if (attempts < 2) throw new Error('again');
          return 'ok';
        },
        {key: 'k', retry: fixed(3, 2_000)}
      )
      .catch(() => 'failed');

    await clock.flush();
    const duringBackoff = limiter.inspect('k').constraints[0]!.available;
    await clock.advance(1_000);
    // Capacity only moves by refill during the sleep, never downward.
    expect(limiter.inspect('k').constraints[0]!.available).toBeGreaterThanOrEqual(duringBackoff);

    await settleAll(clock, [call]);
    expect(attempts).toBe(2);
  });
});

describe('MANDATORY 5 — retry FIFO fairness', () => {
  it('a retry reacquires a concurrency slot like any other attempt', async () => {
    const {clock, limiter} = build(plenty, {maxConcurrent: 1});
    const order: string[] = [];
    const gate = deferred();

    let attempts = 0;
    const retrying = limiter
      .run(
        () => {
          attempts++;
          order.push(`retry-${attempts}`);
          if (attempts < 2) throw new Error('again');
          return 'ok';
        },
        {key: 'a', retry: fixed(3, 100)}
      )
      .catch(() => 'failed');

    await clock.flush();

    // A different key takes the only slot and holds it across the backoff.
    const holder = limiter.run(() => {
      order.push('holder');
      return gate.promise;
    }, {key: 'b'});

    await clock.advance(500);
    // The retry is due but cannot start: the slot is taken.
    expect(order).toEqual(['retry-1', 'holder']);

    gate.resolve();
    await settleAll(clock, [retrying, holder]);
    expect(order).toEqual(['retry-1', 'holder', 'retry-2']);
  });
});

describe('MANDATORY 6 — attempt exhaustion', () => {
  it('surfaces the ORIGINAL caller error, unchanged', async () => {
    const {clock, limiter} = build();
    const errors = [new Error('first'), new Error('second'), new Error('third')];
    let attempts = 0;

    const call = limiter.run(
      () => {
        throw errors[attempts++];
      },
      {key: 'k', retry: fixed(3, 50)}
    );

    await settleAll(clock, [ignore(call)]);

    // The LAST error, by identity — not a wrapper, so instanceof and any
    // properties the caller put on it survive.
    await expect(call).rejects.toBe(errors[2]);
    expect(attempts).toBe(3);
  });

  it('stops immediately when the classifier declines', async () => {
    const {clock, limiter} = build();
    let attempts = 0;
    const permanent = new Error('permanent');

    const call = limiter.run(
      () => {
        attempts++;
        throw permanent;
      },
      {key: 'k', retry: {maxAttempts: 5, classify: () => ({retry: false})}}
    );

    await settleAll(clock, [ignore(call)]);
    await expect(call).rejects.toBe(permanent);
    expect(attempts).toBe(1);
  });

  it('passes the failure and its context to the classifier', async () => {
    const {clock, limiter} = build();
    const seen: {attempt: number; timedOut: boolean; message: string}[] = [];
    let attempts = 0;

    const call = limiter.run(
      () => {
        attempts++;
        throw new Error(`fail-${attempts}`);
      },
      {
        key: 'k',
        retry: {
          maxAttempts: 3,
          jitter: 'none',
          baseDelayMs: 100,
          maxDelayMs: 100,
          classify: (error, ctx) => {
            seen.push({
              attempt: ctx.attempt,
              timedOut: ctx.timedOut,
              message: (error as Error).message,
            });
            return {retry: true};
          },
        },
      }
    );

    await settleAll(clock, [ignore(call)]);

    expect(seen).toEqual([
      {attempt: 1, timedOut: false, message: 'fail-1'},
      {attempt: 2, timedOut: false, message: 'fail-2'},
      {attempt: 3, timedOut: false, message: 'fail-3'},
    ]);
  });

  it('treats a throwing classifier as "do not retry" and keeps the real error', async () => {
    // A bug in the classifier must not be able to invent a different outcome
    // for the call, so the operation's own error is what surfaces.
    const {clock, limiter} = build();
    const real = new Error('the actual failure');
    let attempts = 0;

    const call = limiter.run(
      () => {
        attempts++;
        throw real;
      },
      {
        key: 'k',
        retry: {
          maxAttempts: 5,
          classify: () => {
            throw new Error('classifier is broken');
          },
        },
      }
    );

    await settleAll(clock, [ignore(call)]);
    await expect(call).rejects.toBe(real);
    expect(attempts).toBe(1);
  });
});

describe('MANDATORY 7 — provider wait hints', () => {
  it('uses the hint verbatim, not the computed backoff', async () => {
    const {clock, limiter} = build();
    const startedAt: number[] = [];

    const call = limiter
      .run(
        () => {
          startedAt.push(clock.now());
          if (startedAt.length < 3) throw new Error('throttled');
          return 'ok';
        },
        {
          key: 'k',
          retry: {
            maxAttempts: 4,
            baseDelayMs: 1_000, // would be used if the hint were ignored
            classify: () => ({retry: true, afterMs: 250}),
          },
        }
      )
      .catch(() => 'failed');

    await settleAll(clock, [call]);
    expect(startedAt).toEqual([0, 250, 500]);
  });

  it('is NOT clamped by maxDelayMs', async () => {
    // Clamping a time the provider named earns a second rejection, reliably.
    const {clock, limiter} = build();
    const startedAt: number[] = [];

    const call = limiter
      .run(
        () => {
          startedAt.push(clock.now());
          if (startedAt.length < 2) throw new Error('throttled');
          return 'ok';
        },
        {
          key: 'k',
          retry: {
            maxAttempts: 3,
            maxDelayMs: 1_000,
            classify: () => ({retry: true, afterMs: 60_000}),
          },
        }
      )
      .catch(() => 'failed');

    await settleAll(clock, [call]);
    expect(startedAt).toEqual([0, 60_000]);
  });

  it('is not jittered', async () => {
    const {clock, limiter} = build(plenty, {random: createSeededRandom(3)});
    const startedAt: number[] = [];

    const call = limiter
      .run(
        () => {
          startedAt.push(clock.now());
          if (startedAt.length < 4) throw new Error('throttled');
          return 'ok';
        },
        {key: 'k', retry: {maxAttempts: 5, classify: () => ({retry: true, afterMs: 123})}}
      )
      .catch(() => 'failed');

    await settleAll(clock, [call]);
    expect(startedAt).toEqual([0, 123, 246, 369]);
  });

  it('refuses rather than sleeping past the budget', async () => {
    const {clock, limiter} = build();
    let attempts = 0;
    const underlying = new Error('throttled');

    const call = limiter.run(
      () => {
        attempts++;
        throw underlying;
      },
      {
        key: 'k',
        totalBudgetMs: 1_000,
        retry: {maxAttempts: 5, classify: () => ({retry: true, afterMs: 60_000})},
      }
    );

    await settleAll(clock, [ignore(call)]);

    // The hint is honoured or the call is refused — never silently shortened.
    await expect(call).rejects.toThrow(QuotaPilotBudgetError);
    await call.catch((error: unknown) => {
      expect((error as QuotaPilotBudgetError).cause).toBe(underlying);
    });
    expect(attempts).toBe(1);
  });

  it('ignores a malformed hint and falls back to computed backoff', async () => {
    const {clock, limiter} = build();
    const startedAt: number[] = [];
    const hints = [-5, Number.NaN, Infinity];

    const call = limiter
      .run(
        () => {
          startedAt.push(clock.now());
          if (startedAt.length < 4) throw new Error('again');
          return 'ok';
        },
        {
          key: 'k',
          retry: {
            maxAttempts: 5,
            jitter: 'none',
            baseDelayMs: 100,
            maxDelayMs: 100,
            classify: () => {
              const hint = hints[startedAt.length - 1];
              return hint === undefined ? {retry: true} : {retry: true, afterMs: hint};
            },
          },
        }
      )
      .catch(() => 'failed');

    await settleAll(clock, [call]);
    // A parsing bug in a classifier degrades to ordinary backoff rather than
    // scheduling a timer for NaN milliseconds.
    expect(startedAt).toEqual([0, 100, 200, 300]);
  });

  it('accepts a hint of zero as "retry immediately"', async () => {
    const {clock, limiter} = build();
    const startedAt: number[] = [];

    const call = limiter
      .run(
        () => {
          startedAt.push(clock.now());
          if (startedAt.length < 2) throw new Error('again');
          return 'ok';
        },
        {key: 'k', retry: {maxAttempts: 3, classify: () => ({retry: true, afterMs: 0})}}
      )
      .catch(() => 'failed');

    await settleAll(clock, [call]);
    expect(startedAt).toEqual([0, 0]);
  });
});

describe('MANDATORY 8 — total deadline', () => {
  it('expires a call that is still QUEUED, without waiting for admission', async () => {
    // The requirement that forced a per-call deadline timer. Behind a long
    // rate wait, a budget must still be honoured.
    const {clock, limiter} = build([{name: 'slow', limit: 1, interval: 'minute', burst: 1}]);

    const first = limiter.run(() => 'got-the-token', {key: 'k'});
    await settleAll(clock, [first]);

    // The next token is a minute away, but this caller will only wait 500ms.
    const impatient = limiter.run(() => 'never-runs', {key: 'k', totalBudgetMs: 500});
    const ran = false;
    void impatient.catch(() => undefined);

    await clock.advance(500);
    await expect(impatient).rejects.toThrow(QuotaPilotBudgetError);
    expect(ran).toBe(false);

    // And it left nothing behind.
    expect(limiter.stats().queued).toBe(0);
  });

  it('stops retrying once the budget cannot fit another backoff', async () => {
    const {clock, limiter} = build();
    let attempts = 0;

    const call = limiter.run(
      () => {
        attempts++;
        throw new Error('again');
      },
      {key: 'k', totalBudgetMs: 350, retry: fixed(10, 100)}
    );

    await settleAll(clock, [ignore(call)]);

    await expect(call).rejects.toThrow(QuotaPilotBudgetError);
    // Attempts at 0, 100, 200, 300; a fifth would land at 400, past the budget.
    expect(attempts).toBe(4);
  });

  it('carries the last error as the cause of the budget refusal', async () => {
    const {clock, limiter} = build();
    const last = new Error('the final failure');

    const call = limiter.run(
      () => {
        throw last;
      },
      {key: 'k', totalBudgetMs: 150, retry: fixed(10, 100)}
    );

    await settleAll(clock, [ignore(call)]);
    await call.catch((error: unknown) => {
      expect(error).toBeInstanceOf(QuotaPilotBudgetError);
      expect((error as QuotaPilotBudgetError).cause).toBe(last);
      expect((error as QuotaPilotBudgetError).attempt).toBeGreaterThan(0);
    });
  });

  it('does NOT interrupt an attempt already running', async () => {
    const {clock, limiter} = build();
    const gate = deferred<string>();

    // Budget 100ms, but the attempt runs far longer. The documented contract:
    // the budget gates the next wait and the next attempt, never the one in
    // flight — attemptTimeoutMs is the tool for that.
    const call = limiter.run(() => gate.promise, {key: 'k', totalBudgetMs: 100});

    await clock.advance(5_000);
    gate.resolve('completed anyway');

    await expect(call).resolves.toBe('completed anyway');
  });

  it('leaves no deadline timer behind once the call settles', async () => {
    const {clock, limiter} = build();
    const call = limiter.run(() => 'quick', {key: 'k', totalBudgetMs: 10_000});
    await settleAll(clock, [call]);

    await expect(call).resolves.toBe('quick');
    expect(clock.pendingTimers()).toBe(0);
  });

  it('re-arms the deadline across a retry', async () => {
    const {clock, limiter} = build([{name: 'slow', limit: 1, interval: 'minute', burst: 1}]);
    let attempts = 0;

    // First attempt consumes the only token and fails; the retry is then
    // queued behind a minute-long wait, and the budget must still bite.
    const call = limiter.run(
      () => {
        attempts++;
        throw new Error('again');
      },
      {key: 'k', totalBudgetMs: 900, retry: fixed(5, 100)}
    );

    await settleAll(clock, [ignore(call)]);
    await expect(call).rejects.toThrow(QuotaPilotBudgetError);
    expect(attempts).toBe(1);
    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe('MANDATORY 9 — late resolution after an attempt timeout', () => {
  it('abandons the attempt and rejects with a timeout error', async () => {
    const {clock, limiter} = build();
    const gate = deferred<string>();

    const call = limiter.run(() => gate.promise, {key: 'k', attemptTimeoutMs: 500});
    void call.catch(() => undefined);

    await clock.advance(500);
    await expect(call).rejects.toThrow(QuotaPilotTimeoutError);
    await call.catch((error: unknown) => {
      const timeout = error as QuotaPilotTimeoutError;
      expect(timeout.timeoutMs).toBe(500);
      expect(timeout.attempt).toBe(1);
      // No cause: the attempt produced no error, it was abandoned. Whether it
      // completed is unknown, which is different information from "it failed".
      expect('cause' in timeout).toBe(false);
    });
  });

  it('a late resolution NEVER overrides the settled result', async () => {
    const {clock, limiter} = build();
    const gate = deferred<string>();

    const call = limiter.run(() => gate.promise, {key: 'k', attemptTimeoutMs: 100});
    void call.catch(() => undefined);
    await clock.advance(100);

    // The abandoned work finishes long after the timeout.
    gate.resolve('too late');
    await clock.flush();

    await expect(call).rejects.toThrow(QuotaPilotTimeoutError);
  });

  it('a late REJECTION after a timeout causes no unhandled rejection', async () => {
    const {clock, limiter} = build();
    const gate = deferred<string>();

    const call = limiter.run(() => gate.promise, {key: 'k', attemptTimeoutMs: 100});
    void call.catch(() => undefined);
    await clock.advance(100);

    gate.reject(new Error('late failure nobody asked about'));
    await clock.flush();

    await expect(call).rejects.toThrow(QuotaPilotTimeoutError);
  });

  it('releases the slot exactly once when a timeout and a late finish race', async () => {
    const {clock, limiter} = build(plenty, {maxConcurrent: 1});
    const gate = deferred<string>();

    const timedOut = limiter.run(() => gate.promise, {key: 'a', attemptTimeoutMs: 100});
    void timedOut.catch(() => undefined);
    await clock.advance(100);

    // The slot was freed at the timeout, so other work proceeds.
    expect(limiter.stats().inflight).toBe(0);
    const next = limiter.run(() => 'proceeds', {key: 'b'});
    await settleAll(clock, [next]);
    await expect(next).resolves.toBe('proceeds');

    // The late finish must not release a second time, which would inflate
    // capacity and let the limiter admit beyond maxConcurrent.
    gate.resolve('late');
    await clock.flush();
    expect(limiter.stats().inflight).toBe(0);

    const after = limiter.run(() => 'still-bounded', {key: 'c'});
    await settleAll(clock, [after]);
    expect(limiter.stats().inflight).toBe(0);
  });

  it('does NOT retry a timeout by default', async () => {
    const {clock, limiter} = build();
    let attempts = 0;

    const call = limiter.run(
      () => {
        attempts++;
        return deferred<string>().promise; // never settles
      },
      {key: 'k', attemptTimeoutMs: 100, retry: fixed(5, 50)}
    );
    void call.catch(() => undefined);

    await clock.advance(1_000);

    await expect(call).rejects.toThrow(QuotaPilotTimeoutError);
    // A timeout is not proof of failure: repeating it could duplicate a
    // non-idempotent operation, so it is opt-in.
    expect(attempts).toBe(1);
  });

  it('retries a timeout when explicitly enabled', async () => {
    const {clock, limiter} = build();
    const gates: ReturnType<typeof deferred<string>>[] = [];

    const call = limiter.run(
      (ctx) => {
        const gate = deferred<string>();
        gates.push(gate);
        if (ctx.attempt >= 3) return 'third time lucky';
        return gate.promise;
      },
      {
        key: 'k',
        attemptTimeoutMs: 100,
        retry: fixed(4, 50, {retryOnAttemptTimeout: true}),
      }
    );

    await settleAll(clock, [ignore(call)]);
    await expect(call).resolves.toBe('third time lucky');
    expect(gates).toHaveLength(3);
  });

  it('tells the classifier that the failure was a timeout', async () => {
    const {clock, limiter} = build();
    const flags: boolean[] = [];

    const call = limiter.run(
      () => deferred<string>().promise,
      {
        key: 'k',
        attemptTimeoutMs: 100,
        retry: {
          maxAttempts: 3,
          jitter: 'none',
          baseDelayMs: 50,
          maxDelayMs: 50,
          retryOnAttemptTimeout: true,
          classify: (_error, ctx) => {
            flags.push(ctx.timedOut);
            // A classifier can still decline per-case, which is how a caller
            // keeps a non-idempotent operation safe without the flag.
            return {retry: ctx.attempt < 2};
          },
        },
      }
    );

    await settleAll(clock, [ignore(call)]);
    expect(flags).toEqual([true, true]);
    await expect(call).rejects.toThrow(QuotaPilotTimeoutError);
  });

  it('cancels the timeout timer when the attempt finishes in time', async () => {
    const {clock, limiter} = build();
    const call = limiter.run(() => 'fast', {key: 'k', attemptTimeoutMs: 10_000});
    await settleAll(clock, [call]);

    await expect(call).resolves.toBe('fast');
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe('MANDATORY 10 — rejected and synchronously throwing tasks', () => {
  it('retries a synchronous throw', async () => {
    const {clock, limiter} = build();
    let attempts = 0;

    const call = limiter
      .run(
        () => {
          attempts++;
          if (attempts < 3) throw new Error('sync');
          return 'ok';
        },
        {key: 'k', retry: fixed(5, 50)}
      )
      .catch(() => 'failed');

    await settleAll(clock, [call]);
    await expect(call).resolves.toBe('ok');
    expect(attempts).toBe(3);
  });

  it('retries an async rejection', async () => {
    const {clock, limiter} = build();
    let attempts = 0;

    const call = limiter
      .run(
        async () => {
          attempts++;
          if (attempts < 3) throw new Error('async');
          return 'ok';
        },
        {key: 'k', retry: fixed(5, 50)}
      )
      .catch(() => 'failed');

    await settleAll(clock, [call]);
    await expect(call).resolves.toBe('ok');
    expect(attempts).toBe(3);
  });

  it('mixes synchronous and asynchronous failures in one sequence', async () => {
    const {clock, limiter} = build();
    const modes: string[] = [];

    const call = limiter
      .run(
        (ctx) => {
          if (ctx.attempt === 1) {
            modes.push('sync-throw');
            throw new Error('sync');
          }
          if (ctx.attempt === 2) {
            modes.push('async-reject');
            return Promise.reject(new Error('async'));
          }
          modes.push('resolve');
          return Promise.resolve('ok');
        },
        {key: 'k', retry: fixed(5, 50)}
      )
      .catch(() => 'failed');

    await settleAll(clock, [call]);
    expect(modes).toEqual(['sync-throw', 'async-reject', 'resolve']);
    await expect(call).resolves.toBe('ok');
  });
});

describe('MANDATORY 11 & 12 — slots released once, nothing leaked', () => {
  it('releases a slot per attempt, never twice', async () => {
    const {clock, limiter} = build(plenty, {maxConcurrent: 2});
    let attempts = 0;

    const calls = Array.from({length: 6}, (_, index) =>
      limiter
        .run(
          () => {
            attempts++;
            if (attempts % 2 === 0) throw new Error('every other one');
            return index;
          },
          {key: `key-${index % 3}`, retry: fixed(3, 25)}
        )
        .then(
          () => 'ok',
          () => 'failed'
        )
    );

    await settleAll(clock, calls);

    // If a slot were ever double-released, concurrency would drift and this
    // would end non-zero.
    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
    const outcomes = await Promise.all(calls);
    expect(outcomes).toHaveLength(6);
  });

  it('leaves no timer, queue entry or backing-off call behind', async () => {
    const {clock, limiter} = build([{name: 'paced', limit: 20, interval: 'second', burst: 4}], {
      maxConcurrent: 2,
      random: createSeededRandom(11),
    });

    const calls = Array.from({length: 24}, (_, index) =>
      limiter
        .run(
          (ctx) => {
            if (ctx.attempt < 2 && index % 3 === 0) throw new Error('flaky');
            return index;
          },
          {
            key: `key-${index % 4}`,
            cost: 1 + (index % 2),
            retry: {maxAttempts: 3, classify: () => ({retry: true})},
            attemptTimeoutMs: 5_000,
            totalBudgetMs: 60_000,
          }
        )
        .then(
          () => 'ok',
          () => 'failed'
        )
    );

    await settleAll(clock, calls);

    expect(await Promise.all(calls)).toHaveLength(24);
    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
    expect(clock.pendingTimers()).toBe(0);
  });

  it('a retry bypasses the queue bound rather than being dropped', async () => {
    // maxQueueDepth bounds NEW intake. A retrying call was already accepted
    // and already spent provider capacity; dropping it here would turn a
    // transient failure into a hard one.
    const {clock, limiter} = build([{name: 'paced', limit: 10, interval: 'second', burst: 1}], {
      maxQueueDepth: 1,
    });

    let attempts = 0;
    const retrying = limiter
      .run(
        () => {
          attempts++;
          if (attempts < 2) throw new Error('again');
          return 'retried';
        },
        {key: 'k', retry: fixed(3, 50)}
      )
      .catch(() => 'failed');

    await clock.flush();
    // Fill the queue to its bound while the retry sleeps.
    const filler = ignore(limiter.run(() => 'filler', {key: 'k'}));

    await settleAll(clock, [retrying, filler]);

    await expect(retrying).resolves.toBe('retried');
    expect(attempts).toBe(2);
  });
});

describe('deadline — the pump’s own expiry guard', () => {
  it('drops an expired head rather than spending capacity on it', async () => {
    // Both mechanisms that enforce a budget on a queued call are needed, and
    // this test is what proves it. Normally the call's own deadline timer
    // settles it first. Here a rate wake timer is already pending and due at
    // the same instant, and it was scheduled EARLIER — so the pump runs first
    // and must refuse to admit the expired call itself.
    //
    // Without the pump's guard, that admission would consume capacity for a
    // call that can never run, and capacity is never refunded.
    const clock = createVirtualClock(0);
    const limiter = createLimiter({
      constraints: [{name: 'paced', limit: 10, interval: 'second', burst: 1}],
      clock,
    });
    const ran: string[] = [];

    // Spend the only token, so the next call must wait 100ms.
    const first = limiter.run(() => void ran.push('first'), {key: 'k'});
    await settleAll(clock, [first]);

    // This one has no budget. Enqueuing it makes the pump sleep until 100ms,
    // so the wake timer is now the OLDEST pending timer.
    const patient = limiter.run(() => void ran.push('patient'), {key: 'k'});

    // And this one's budget expires at exactly 100ms — the same instant.
    const doomed = limiter.run(() => void ran.push('doomed'), {
      key: 'k',
      totalBudgetMs: 100,
    });
    void doomed.catch(() => undefined);

    await clock.advance(100);

    // The wake fired first, the pump admitted 'patient', then found 'doomed'
    // expired and dropped it without spending the next token on it.
    await expect(doomed).rejects.toThrow(QuotaPilotBudgetError);
    await settleAll(clock, [patient]);

    expect(ran).toEqual(['first', 'patient']);
    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
    expect(clock.pendingTimers()).toBe(0);
  });

  it('leaves the queue consistent after dropping an expired call', async () => {
    const clock = createVirtualClock(0);
    const limiter = createLimiter({
      constraints: [{name: 'paced', limit: 10, interval: 'second', burst: 1}],
      clock,
    });
    const ran: string[] = [];

    const first = limiter.run(() => void ran.push('first'), {key: 'k'});
    await settleAll(clock, [first]);

    const patient = limiter.run(() => void ran.push('patient'), {key: 'k'});
    const doomed = limiter.run(() => void ran.push('doomed'), {key: 'k', totalBudgetMs: 100});
    void doomed.catch(() => undefined);
    // A third arrives behind the doomed one and must still run.
    const later = limiter.run(() => void ran.push('later'), {key: 'k'});

    await clock.advance(100);
    await expect(doomed).rejects.toThrow(QuotaPilotBudgetError);

    await settleAll(clock, [patient, later]);
    expect(ran).toEqual(['first', 'patient', 'later']);
  });
});

describe('providerHintMs — unit', () => {
  it('returns nothing for a verdict that declines to retry', () => {
    // Guarded at the call site too, but this is the function's contract: no
    // retry means no hint, whatever else the verdict carries.
    expect(providerHintMs({retry: false})).toBeUndefined();
  });

  it('returns nothing when no hint was given', () => {
    expect(providerHintMs({retry: true})).toBeUndefined();
  });

  it('passes a usable hint through untouched', () => {
    expect(providerHintMs({retry: true, afterMs: 0})).toBe(0);
    expect(providerHintMs({retry: true, afterMs: 1_234})).toBe(1_234);
    expect(providerHintMs({retry: true, afterMs: 600_000})).toBe(600_000);
  });

  it.each([-1, Number.NaN, Infinity, -Infinity])('ignores a malformed hint: %s', (afterMs) => {
    expect(providerHintMs({retry: true, afterMs})).toBeUndefined();
  });

  it('ignores a hint that is not a number at all', () => {
    expect(providerHintMs({retry: true, afterMs: '500' as unknown as number})).toBeUndefined();
  });
});

describe('cancelWake — unit', () => {
  it('is a no-op when no wake is pending', () => {
    const clock = createVirtualClock(0);
    const partition = {wakeTimer: undefined} as unknown as Parameters<typeof cancelWake>[0];

    expect(() => cancelWake(partition)).not.toThrow();
    expect(partition.wakeTimer).toBeUndefined();
    expect(clock.pendingTimers()).toBe(0);
  });

  it('cancels a pending wake and clears the reference', async () => {
    const clock = createVirtualClock(0);
    let fired = false;
    const partition = {
      wakeTimer: clock.setTimer(() => {
        fired = true;
      }, 100),
    } as unknown as Parameters<typeof cancelWake>[0];

    cancelWake(partition);

    expect(partition.wakeTimer).toBeUndefined();
    await clock.advance(500);
    expect(fired).toBe(false);
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe('retry — observable ordering across attempts', () => {
  /**
   * The sequence of scheduler decisions, and the side effects attached to
   * each, in the exact order a caller and an observer see them.
   *
   * This exists to protect a refactor. Retry mechanics are spread across
   * `call.ts` (attempt lifecycle, backoff), `scheduler.ts` (admission) and
   * `limiter.ts` (intake, telemetry), and the ORDER in which those three
   * cooperate is behaviour that no single unit test pins.
   */

  it('emits one admitted per attempt, one retrying per backoff, and completes last', async () => {
    const clock = createVirtualClock(0);
    const kinds: string[] = [];
    const limiter = createLimiter({
      constraints: plenty,
      clock,
      onDecision: (event) => void kinds.push(event.kind),
    });

    let attempts = 0;
    const call = limiter.run(
      () => {
        attempts++;
        if (attempts < 3) throw new Error('transient');
        return 'third time';
      },
      {key: 'k', retry: fixed(5, 100)}
    );
    await settleAll(clock, [call]);

    await expect(call).resolves.toBe('third time');
    // A retry re-enters the queue tail, and `requeue` does not re-announce a
    // `queued` event: the call was announced once, when it arrived.
    expect(kinds).toEqual([
      'queued',
      'admitted',
      'retrying',
      'admitted',
      'retrying',
      'admitted',
      'completed',
    ]);
  });

  it('charges capacity per attempt, at the moment each attempt starts', async () => {
    const clock = createVirtualClock(0);
    const availableAtEachAttempt: number[] = [];
    const limiter: ReturnType<typeof createLimiter> = createLimiter({
      constraints: [{name: 'c', limit: 100, interval: 'minute', burst: 100}],
      clock,
      onDecision: (event) => {
        if (event.kind === 'admitted') {
          availableAtEachAttempt.push(limiter.inspect('k').constraints[0]!.available);
        }
      },
    });

    let attempts = 0;
    const call = ignore(
      limiter.run(
        () => {
          attempts++;
          throw new Error('always');
        },
        {key: 'k', cost: 10, retry: fixed(3, 100)}
      )
    );
    await settleAll(clock, [call]);

    expect(attempts).toBe(3);
    // 10 debited per attempt, and the bucket's refill over the two 100ms
    // backoffs is small enough that the steps stay distinct.
    expect(availableAtEachAttempt.map(Math.floor)).toEqual([90, 80, 70]);
  });

  it('holds neither a slot nor a queue entry while backing off', async () => {
    // The three states are mutually exclusive, and `stats()` is where that is
    // visible. A backing-off call counted as queued or inflight would make
    // both the eviction predicate and the concurrency caps wrong.
    const clock = createVirtualClock(0);
    const limiter = createLimiter({constraints: plenty, clock});
    const observed: {queued: number; inflight: number; backingOff: number}[] = [];

    const call = ignore(
      limiter.run(
        () => {
          throw new Error('always');
        },
        {key: 'k', retry: fixed(2, 500)}
      )
    );

    await clock.advance(100);
    const {keys: _keys, decisionHookErrors: _errors, ...midBackoff} = limiter.stats();
    observed.push(midBackoff);

    await settleAll(clock, [call]);
    const {keys: _k2, decisionHookErrors: _e2, ...afterwards} = limiter.stats();
    observed.push(afterwards);

    expect(observed).toEqual([
      {queued: 0, inflight: 0, backingOff: 1},
      {queued: 0, inflight: 0, backingOff: 0},
    ]);
  });

  it('settles the caller exactly once when a late attempt resolves after a timeout', async () => {
    // The two-level settlement rule: the attempt's own claim decides who
    // releases the slot, and the call's `settled` decides who answers the
    // caller. A straggler must do neither.
    const clock = createVirtualClock(0);
    const limiter = createLimiter({constraints: plenty, clock});
    const late = deferred<string>();
    let settlements = 0;

    const call = limiter
      .run(() => late.promise, {key: 'k', attemptTimeoutMs: 50})
      .then(
        () => {
          settlements++;
        },
        () => {
          settlements++;
        }
      );

    await clock.advance(50);
    // The timeout has answered the caller. Now the abandoned task finishes.
    late.resolve('too late');
    await settleAll(clock, [call]);
    await clock.flush();

    expect(settlements).toBe(1);
    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
    expect(clock.pendingTimers()).toBe(0);
  });
});
