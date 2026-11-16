import {describe, expect, it} from 'vitest';

import {createLimiter} from '../src/limiter.js';
import {
  LimiterConfigError,
  LimiterKeyLimitError,
  LimiterQueueFullError,
} from '../src/errors.js';
import type {AttemptContext, RateConstraint} from '../src/types.js';
import {deferred, ignore, type Deferred} from './harness/deferred.js';
import {settleAll} from './harness/settle.js';
import {createVirtualClock, type VirtualClock} from './harness/virtual-clock.js';

/** 10 per second, no bursting beyond the limit. */
const perSecond10: RateConstraint[] = [{name: 'per-second', limit: 10, interval: 'second'}];
/** One per 100 ms, strictly paced. */
const paced: RateConstraint[] = [{name: 'paced', limit: 10, interval: 'second', burst: 1}];

function build(constraints: RateConstraint[], extra: Record<string, unknown> = {}) {
  const clock = createVirtualClock(0);
  const limiter = createLimiter({constraints, clock, ...extra});
  return {clock, limiter};
}

/** Records when each call ran, by label. */
function recorder(clock: VirtualClock) {
  const order: string[] = [];
  const times: number[] = [];
  return {
    order,
    times,
    task: (label: string) => () => {
      order.push(label);
      times.push(clock.now());
    },
  };
}

describe('createLimiter — configuration', () => {
  it('requires at least one constraint', () => {
    expect(() => createLimiter({constraints: []})).toThrow(LimiterConfigError);
  });

  it('rejects a non-object options bag', () => {
    expect(() => createLimiter(null as unknown as {constraints: []})).toThrow(
      LimiterConfigError
    );
  });

  it.each([
    ['maxConcurrent', 0],
    ['maxConcurrent', -1],
    ['maxConcurrent', 1.5],
    ['maxConcurrentPerKey', 0],
    ['maxQueueDepth', 0],
    ['maxQueueDepth', 2.5],
    ['maxKeys', 0],
  ])('rejects %s = %s', (option, value) => {
    expect(() => createLimiter({constraints: perSecond10, [option]: value})).toThrow(
      LimiterConfigError
    );
  });

  it('accepts Infinity for the count options', () => {
    expect(() =>
      createLimiter({
        constraints: perSecond10,
        maxConcurrent: Infinity,
        maxConcurrentPerKey: Infinity,
        maxKeys: Infinity,
      })
    ).not.toThrow();
  });

  it('rejects a negative sweep interval', () => {
    expect(() => createLimiter({constraints: perSecond10, sweepIntervalMs: -1})).toThrow(
      LimiterConfigError
    );
  });

  it('surfaces the long-window warning as data', () => {
    const {limiter} = build([{name: 'daily', limit: 1_000, interval: 'day'}]);
    expect(limiter.warnings).toHaveLength(1);
    expect(limiter.warnings[0]).toMatch(/state in this process only/);
  });

  it('rejects a cost no constraint could admit, synchronously', () => {
    const {limiter} = build(perSecond10);
    // Not a rejected promise: a cost above capacity is a programming error.
    expect(() => limiter.run(() => 'x', {cost: 11})).toThrow(LimiterConfigError);
  });

  it.each([0, -1, Number.NaN])('rejects cost %s synchronously', (cost) => {
    const {limiter} = build(perSecond10);
    expect(() => limiter.run(() => 'x', {cost})).toThrow(LimiterConfigError);
  });

  it('rejects a non-function task and a non-string key', () => {
    const {limiter} = build(perSecond10);
    expect(() => limiter.run(undefined as unknown as () => void)).toThrow(LimiterConfigError);
    expect(() => limiter.run(() => 'x', {key: 7 as unknown as string})).toThrow(
      LimiterConfigError
    );
  });
});

describe('run() — validation contract', () => {
  /**
   * Two properties, and both are observable so both are pinned.
   *
   * EVERY option is validated before the promise exists, so a configuration
   * mistake throws at the call site rather than arriving as a rejection. A
   * library that mixes the two for one class of mistake is one you cannot
   * reason about — and `maxAttempts: 0` was briefly a rejection while
   * `cost: 0` threw, which is exactly the inconsistency this guards.
   *
   * And when SEVERAL options are wrong at once, which error surfaces is
   * determined by the order of the checks. That order is behaviour: callers
   * read the first message they get and fix that field. It must survive any
   * rearrangement of the validation code.
   */

  const validRetry = {maxAttempts: 2, classify: () => ({retry: false as const})};

  it.each([
    ['fn', [undefined, {}], /requires a function/],
    ['key', [() => 'x', {key: 7}], /key must be a string/],
    ['cost', [() => 'x', {cost: 0}], /cost/],
    ['signal', [() => 'x', {signal: {} as AbortSignal}], /signal must be an AbortSignal/],
    ['onSaturated', [() => 'x', {onSaturated: 'maybe'}], /onSaturated must be/],
    ['retry.classify', [() => 'x', {retry: {maxAttempts: 2}}], /retry\.classify is required/],
    ['retry.maxAttempts', [() => 'x', {retry: {...validRetry, maxAttempts: 0}}], /maxAttempts/],
    ['attemptTimeoutMs', [() => 'x', {attemptTimeoutMs: 0}], /attemptTimeoutMs/],
    ['totalBudgetMs', [() => 'x', {totalBudgetMs: -5}], /totalBudgetMs/],
  ])('throws synchronously for a bad %s, never rejecting', (_label, args, message) => {
    const {limiter} = build(perSecond10);
    const [fn, options] = args as [() => unknown, Record<string, unknown>];

    let thrown: unknown;
    try {
      // Deliberately not awaited: if this returned a promise instead of
      // throwing, the assertion below would catch it as an unexpected pass.
      void limiter.run(fn, options);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LimiterConfigError);
    expect((thrown as Error).message).toMatch(message);
  });

  it('reports the first invalid option in a fixed order', () => {
    // Every option below is invalid at once. The message identifies which
    // check runs first, so this test is the specification of the precedence.
    const {limiter} = build(perSecond10);
    const everythingWrong = {
      key: 7 as unknown as string,
      cost: 0,
      signal: {} as AbortSignal,
      onSaturated: 'maybe' as unknown as 'wait',
      retry: {maxAttempts: 0} as never,
      attemptTimeoutMs: 0,
      totalBudgetMs: -5,
    };

    const firstError = (options: Record<string, unknown>): string => {
      try {
        void limiter.run(() => 'x', options);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('expected a synchronous throw');
    };

    // fn is checked before anything in the options bag.
    expect(firstError({...everythingWrong})).toMatch(/key must be a string/);
    expect(() => limiter.run(undefined as unknown as () => void, everythingWrong)).toThrow(
      /requires a function/
    );

    // Then, peeling off one field at a time, the documented order:
    // key → cost → signal → onSaturated → retry → attemptTimeoutMs → totalBudgetMs
    const {key: _key, ...noKey} = everythingWrong;
    expect(firstError(noKey)).toMatch(/cost/);

    const {cost: _cost, ...noCost} = noKey;
    expect(firstError(noCost)).toMatch(/signal must be an AbortSignal/);

    const {signal: _signal, ...noSignal} = noCost;
    expect(firstError(noSignal)).toMatch(/onSaturated must be/);

    const {onSaturated: _onSaturated, ...noOnSaturated} = noSignal;
    expect(firstError(noOnSaturated)).toMatch(/retry\.classify is required/);

    const {retry: _retry, ...noRetry} = noOnSaturated;
    expect(firstError(noRetry)).toMatch(/attemptTimeoutMs/);

    const {attemptTimeoutMs: _attemptTimeoutMs, ...noAttemptTimeout} = noRetry;
    expect(firstError(noAttemptTimeout)).toMatch(/totalBudgetMs/);
  });

  it('creates no partition and spends nothing when validation fails', () => {
    // A rejected configuration must not leave a tracked key behind, which
    // would otherwise count against maxKeys for a call that never ran.
    const {limiter} = build(perSecond10);

    expect(() => limiter.run(() => 'x', {key: 'never-tracked', cost: 0})).toThrow(
      LimiterConfigError
    );

    expect(limiter.stats()).toMatchObject({keys: 0, queued: 0, inflight: 0});
    expect(limiter.inspect('never-tracked').tracked).toBe(false);
  });
});

describe('concurrency accounting — one owner for inflight', () => {
  /**
   * `stats().inflight` is the public face of a counter that admission
   * increments and attempt settlement decrements. Every path that starts an
   * attempt must account for it identically, and there are two such paths —
   * the pump, and `onSaturated: 'reject'`, which bypasses the queue entirely.
   *
   * These tests exercise both, including the awkward cases: a task that throws
   * in the same synchronous turn it was started, and a completion that
   * re-enters the pump from inside its own stack frame.
   */

  it('returns to zero after a task that throws synchronously, on the queued path', async () => {
    const {clock, limiter} = build(perSecond10);
    const calls = Array.from({length: 5}, () =>
      ignore(
        limiter.run(() => {
          throw new Error('sync');
        })
      )
    );
    await settleAll(clock, calls);

    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
  });

  it('returns to zero after a task that throws synchronously, on the reject path', async () => {
    const {clock, limiter} = build(perSecond10);
    const calls = Array.from({length: 5}, () =>
      ignore(
        limiter.run(
          () => {
            throw new Error('sync');
          },
          {onSaturated: 'reject'}
        )
      )
    );
    await settleAll(clock, calls);

    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
  });

  it('counts a reject-path call as inflight while it runs', async () => {
    const {clock, limiter} = build(perSecond10);
    const gate = deferred<string>();

    const call = limiter.run(() => gate.promise, {key: 'k', onSaturated: 'reject'});
    // Started synchronously, so the count is already visible.
    expect(limiter.stats().inflight).toBe(1);
    expect(limiter.inspect('k').inflight).toBe(1);

    gate.resolve('done');
    await settleAll(clock, [call]);
    expect(limiter.stats().inflight).toBe(0);
  });

  it('enforces maxConcurrentPerKey across both admission paths', async () => {
    // The per-key cap is read from the same counter both paths write, so a
    // mismatch between them would show up as a cap that can be exceeded by
    // mixing the two.
    const {clock, limiter} = build(perSecond10, {maxConcurrentPerKey: 2});
    const gates = [deferred<string>(), deferred<string>()];

    const held = [
      limiter.run(() => gates[0]!.promise, {key: 'k'}),
      limiter.run(() => gates[1]!.promise, {key: 'k', onSaturated: 'reject'}),
    ];
    await clock.flush();
    expect(limiter.stats().inflight).toBe(2);

    // The cap is full, so a third refuses rather than starting.
    let refused: unknown;
    await limiter.run(() => 'third', {key: 'k', onSaturated: 'reject'}).catch((error: unknown) => {
      refused = error;
    });
    expect((refused as {kind?: string}).kind).toBe('key-concurrency');
    expect(limiter.stats().inflight).toBe(2);

    gates.forEach((gate) => {
      gate.resolve('done');
    });
    await settleAll(clock, held);
    expect(limiter.stats().inflight).toBe(0);
  });

  it('never exceeds either cap while a completion re-enters the pump', async () => {
    // Completion re-pumps from inside its own stack frame, so the counter is
    // read and written re-entrantly. Sampling it on every admission is how a
    // transient overshoot would be caught.
    const {clock, limiter} = build(perSecond10, {maxConcurrent: 3, maxConcurrentPerKey: 2});
    const samples: number[] = [];

    const calls = Array.from({length: 24}, (_, index) =>
      ignore(
        limiter.run(
          () => {
            samples.push(limiter.stats().inflight);
            if (index % 3 === 0) throw new Error('sync');
            return index;
          },
          {key: `k${index % 4}`}
        )
      )
    );
    await settleAll(clock, calls);

    expect(samples).toHaveLength(24);
    expect(Math.max(...samples)).toBeLessThanOrEqual(3);
    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
  });
});

describe('ordering — admission, settlement and observation', () => {
  it('commits capacity before the task runs, in the same turn', () => {
    // The atomicity contract, observed from inside the task: by the time it is
    // invoked, its own cost has already been debited.
    const {limiter} = build([{name: 'c', limit: 10, interval: 'minute', burst: 10}]);
    let availableInside = -1;

    void ignore(
      limiter.run(
        () => {
          availableInside = limiter.inspect('k').constraints[0]?.available ?? -1;
        },
        {key: 'k', cost: 4}
      )
    );

    expect(availableInside).toBe(6);
  });

  it('settles the caller before the drain barrier sees the call as finished', async () => {
    // `settle` answers the caller and only then resolves the internal `done`
    // promise, so a `drain()` waiter can never observe a call as complete
    // before its result has been delivered.
    const {clock, limiter} = build(perSecond10);
    const order: string[] = [];

    const call = limiter.run(() => 'value').then((value) => {
      order.push(`caller:${value}`);
    });
    const drained = limiter.drain().then(() => {
      order.push('drain');
    });

    await settleAll(clock, [call, drained]);

    expect(order).toEqual(['caller:value', 'drain']);
  });
});

describe('createLimiter — basic execution', () => {
  it('runs immediately when capacity is free and resolves with the result', async () => {
    const {limiter} = build(perSecond10);
    await expect(limiter.run(() => 'value')).resolves.toBe('value');
  });

  it('awaits an async task and resolves with its value', async () => {
    const {limiter} = build(perSecond10);
    await expect(limiter.run(async () => 42)).resolves.toBe(42);
  });

  it('starts the first call synchronously, before any await', () => {
    // The documented contract: nothing is interposed between committing
    // capacity and invoking the task.
    const {limiter} = build(perSecond10);
    let ran = false;
    void ignore(
      limiter.run(() => {
        ran = true;
      })
    );
    expect(ran).toBe(true);
  });

  it('tells the task which key it ran under and how long it waited', async () => {
    const {clock, limiter} = build(paced);
    const seen: AttemptContext[] = [];
    const calls = [
      limiter.run((ctx) => void seen.push(ctx), {key: 'acct'}),
      limiter.run((ctx) => void seen.push(ctx), {key: 'acct'}),
    ];

    await settleAll(clock, calls);

    // `attempt` is 1-based and present from the first try.
    expect(seen[0]).toMatchObject({key: 'acct', attempt: 1, elapsedMs: 0});
    // And every attempt gets a signal, whether or not the caller passed one.
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.signal.aborted).toBe(false);
    // The second waited out the pacing interval.
    expect(seen[1]?.key).toBe('acct');
    expect(seen[1]?.elapsedMs).toBe(100);
  });
});

describe('MANDATORY 1 — partition isolation', () => {
  it('gives each key its own capacity', async () => {
    const {clock, limiter} = build(paced);
    const rec = recorder(clock);

    // Each key's first call should run at once: capacity is not shared.
    const calls = ['a', 'b', 'c', 'd'].map((key) =>
      limiter.run(rec.task(key), {key})
    );

    await settleAll(clock, calls);

    expect(rec.order).toEqual(['a', 'b', 'c', 'd']);
    expect(rec.times).toEqual([0, 0, 0, 0]);
  });

  it('does not let one key drain another', async () => {
    const {clock, limiter} = build(perSecond10);
    const rec = recorder(clock);

    // Drain key 'a' completely (10 of 10), then key 'b' must still be free.
    const drain = Array.from({length: 10}, () => limiter.run(rec.task('a'), {key: 'a'}));
    const other = limiter.run(rec.task('b'), {key: 'b'});

    await settleAll(clock, [...drain, other]);

    expect(rec.times.filter((t) => t === 0)).toHaveLength(11);
  });

  it('keeps a saturated key from blocking an independent key', async () => {
    const {clock, limiter} = build(paced);
    const rec = recorder(clock);

    // 'slow' queues three calls behind its pacing; 'fast' arrives after and
    // must not wait for them.
    const slow = Array.from({length: 3}, () => limiter.run(rec.task('slow'), {key: 'slow'}));
    const fast = limiter.run(rec.task('fast'), {key: 'fast'});

    await clock.flush();

    // 'fast' already ran at time 0, while two 'slow' calls are still queued.
    expect(rec.order).toEqual(['slow', 'fast']);

    await settleAll(clock, [...slow, fast]);
  });
});

describe('MANDATORY 2 — per-key FIFO ordering', () => {
  it('runs a key’s calls in arrival order under a concurrency cap', async () => {
    const {clock, limiter} = build(perSecond10, {maxConcurrent: 1});
    const gates = Array.from({length: 5}, () => deferred());
    const started: number[] = [];

    const calls = gates.map((gate, index) =>
      limiter.run(() => {
        started.push(index);
        return gate.promise;
      })
    );

    expect(started).toEqual([0]);

    // Release one at a time; each completion must admit exactly the next.
    for (let index = 0; index < gates.length; index++) {
      gates[index]?.resolve();
      await clock.flush();
    }
    await Promise.all(calls);

    expect(started).toEqual([0, 1, 2, 3, 4]);
  });

  it('runs a key’s calls in arrival order under a rate limit', async () => {
    const {clock, limiter} = build(paced);
    const rec = recorder(clock);
    const labels = ['first', 'second', 'third', 'fourth'];

    const calls = labels.map((label) => limiter.run(rec.task(label), {key: 'k'}));

    await settleAll(clock, calls);

    expect(rec.order).toEqual(labels);
    expect(rec.times).toEqual([0, 100, 200, 300]);
  });

  it('keeps order independently within each of several keys', async () => {
    const {clock, limiter} = build(paced);
    const seen: string[] = [];
    const calls: Promise<unknown>[] = [];

    // Interleave arrivals across two keys.
    for (let round = 0; round < 3; round++) {
      for (const key of ['x', 'y']) {
        calls.push(
          limiter.run(() => void seen.push(`${key}${round}`), {key})
        );
      }
    }

    await settleAll(clock, calls);

    expect(seen.filter((s) => s.startsWith('x'))).toEqual(['x0', 'x1', 'x2']);
    expect(seen.filter((s) => s.startsWith('y'))).toEqual(['y0', 'y1', 'y2']);
  });
});

describe('MANDATORY 3 — global concurrency invariants', () => {
  it('never exceeds maxConcurrent across keys', async () => {
    const {clock, limiter} = build([{name: 'generous', limit: 1_000, interval: 'second'}], {
      maxConcurrent: 3,
    });
    const gates: Deferred<void>[] = [];
    let live = 0;
    let peak = 0;

    const calls = Array.from({length: 12}, (_, index) =>
      limiter.run(
        () => {
          live++;
          peak = Math.max(peak, live);
          const gate = deferred();
          gates.push(gate);
          return gate.promise.then(() => {
            live--;
          });
        },
        {key: `key-${index % 4}`}
      )
    );

    expect(live).toBe(3);
    expect(limiter.stats().inflight).toBe(3);

    while (gates.length > 0) {
      gates.shift()?.resolve();
      await clock.flush();
    }
    await Promise.all(calls);

    expect(peak).toBe(3);
    expect(limiter.stats().inflight).toBe(0);
  });

  it('hands a freed slot to the key that waited longest', async () => {
    const {clock, limiter} = build([{name: 'generous', limit: 1_000, interval: 'second'}], {
      maxConcurrent: 1,
    });
    const first = deferred();
    const started: string[] = [];

    const holder = limiter.run(() => {
      started.push('holder');
      return first.promise;
    }, {key: 'holder'});

    // Three distinct keys queue behind the single slot, in this order.
    const waiters = ['a', 'b', 'c'].map((key) =>
      limiter.run(() => void started.push(key), {key})
    );

    expect(started).toEqual(['holder']);

    first.resolve();
    await settleAll(clock, [holder, ...waiters]);

    // Cross-key fairness: FIFO by the time each key became eligible.
    expect(started).toEqual(['holder', 'a', 'b', 'c']);
  });
});

describe('MANDATORY 4 — per-key concurrency invariants', () => {
  it('never exceeds maxConcurrentPerKey, while other keys run freely', async () => {
    const {clock, limiter} = build([{name: 'generous', limit: 1_000, interval: 'second'}], {
      maxConcurrentPerKey: 2,
    });
    const live = new Map<string, number>();
    const peak = new Map<string, number>();
    const gates: Deferred<void>[] = [];

    const calls = ['a', 'b'].flatMap((key) =>
      Array.from({length: 6}, () =>
        limiter.run(
          () => {
            const next = (live.get(key) ?? 0) + 1;
            live.set(key, next);
            peak.set(key, Math.max(peak.get(key) ?? 0, next));
            const gate = deferred();
            gates.push(gate);
            return gate.promise.then(() => {
              live.set(key, (live.get(key) ?? 1) - 1);
            });
          },
          {key}
        )
      )
    );

    // Two per key, both keys at once: the cap is per key, not global.
    expect(limiter.stats().inflight).toBe(4);

    while (gates.length > 0) {
      gates.shift()?.resolve();
      await clock.flush();
    }
    await Promise.all(calls);

    expect(peak.get('a')).toBe(2);
    expect(peak.get('b')).toBe(2);
  });

  it('restarts a key blocked only by its own concurrency cap', async () => {
    const {clock, limiter} = build([{name: 'generous', limit: 1_000, interval: 'second'}], {
      maxConcurrentPerKey: 1,
    });
    const gate = deferred();
    const started: number[] = [];

    const calls = [
      limiter.run(() => {
        started.push(0);
        return gate.promise;
      }, {key: 'k'}),
      limiter.run(() => void started.push(1), {key: 'k'}),
    ];

    expect(started).toEqual([0]);

    // No timer and no global slot is involved — only this key's own
    // completion can wake the pump.
    gate.resolve();
    await clock.flush();
    await Promise.all(calls);

    expect(started).toEqual([0, 1]);
  });
});

describe('MANDATORY 5 — synchronous task failures', () => {
  it('rejects with the thrown error and frees the slot', async () => {
    const {clock, limiter} = build(perSecond10, {maxConcurrent: 1});
    const boom = new Error('boom');

    await expect(limiter.run(() => {
      throw boom;
    })).rejects.toBe(boom);

    expect(limiter.stats().inflight).toBe(0);
    // The limiter still works afterwards: the slot was not leaked.
    const next = limiter.run(() => 'ok');
    await settleAll(clock, [next]);
    await expect(next).resolves.toBe('ok');
  });

  it('keeps the queue moving when every call throws synchronously', async () => {
    const {clock, limiter} = build([{name: 'generous', limit: 1_000, interval: 'second'}], {
      maxConcurrent: 1,
    });
    let attempts = 0;

    const calls = Array.from({length: 25}, () =>
      ignore(
        limiter.run(() => {
          attempts++;
          throw new Error('always');
        })
      )
    );

    await settleAll(clock, calls);

    expect(attempts).toBe(25);
    expect(limiter.stats()).toEqual({keys: 1, queued: 0, inflight: 0, backingOff: 0, decisionHookErrors: 0});
  });

  it('does not overflow the stack when many keys all throw synchronously', async () => {
    // Completion re-pumps synchronously, so a long chain of synchronous
    // failures nests. 250 distinct keys is well past anything realistic.
    const {clock, limiter} = build([{name: 'generous', limit: 1_000, interval: 'second'}], {
      maxConcurrent: 1,
    });

    const calls = Array.from({length: 250}, (_, index) =>
      ignore(
        limiter.run(
          () => {
            throw new Error('sync');
          },
          {key: `key-${index}`}
        )
      )
    );

    await settleAll(clock, calls);

    expect(limiter.stats().inflight).toBe(0);
    expect(limiter.stats().queued).toBe(0);
  });
});

describe('MANDATORY 6 — rejected asynchronous tasks', () => {
  it('rejects with the original reason and frees capacity', async () => {
    const {limiter} = build(perSecond10, {maxConcurrent: 1});
    const failure = new Error('async boom');

    await expect(limiter.run(async () => {
      throw failure;
    })).rejects.toBe(failure);

    expect(limiter.stats().inflight).toBe(0);
  });

  it('counts a rejected call out exactly once', async () => {
    const {clock, limiter} = build([{name: 'generous', limit: 1_000, interval: 'second'}], {
      maxConcurrent: 2,
    });
    const gates = Array.from({length: 6}, () => deferred());

    const calls = gates.map((gate) => ignore(limiter.run(() => gate.promise)));
    expect(limiter.stats().inflight).toBe(2);

    for (const gate of gates) {
      gate.reject(new Error('nope'));
      await clock.flush();
    }
    await Promise.all(calls);

    expect(limiter.stats().inflight).toBe(0);
  });

  it('mixes resolved and rejected calls without losing count', async () => {
    const {clock, limiter} = build([{name: 'generous', limit: 1_000, interval: 'second'}], {
      maxConcurrent: 1,
    });
    const outcomes: string[] = [];

    const calls = Array.from({length: 20}, (_, index) =>
      limiter
        .run(async () => {
          if (index % 3 === 0) throw new Error(`fail-${index}`);
          return index;
        })
        .then(
          () => outcomes.push('ok'),
          () => outcomes.push('err')
        )
    );

    await settleAll(clock, calls);

    expect(outcomes).toHaveLength(20);
    expect(outcomes.filter((o) => o === 'err')).toHaveLength(7);
    expect(limiter.stats()).toEqual({keys: 1, queued: 0, inflight: 0, backingOff: 0, decisionHookErrors: 0});
  });
});

describe('MANDATORY 7 — queue saturation', () => {
  it('rejects past maxQueueDepth with a LimiterQueueFullError', async () => {
    const {clock, limiter} = build(paced, {maxQueueDepth: 2});
    const gate = deferred();

    // One runs, two queue, the fourth is refused.
    const running = limiter.run(() => gate.promise, {key: 'k'});
    const queued = [
      ignore(limiter.run(() => 'a', {key: 'k'})),
      ignore(limiter.run(() => 'b', {key: 'k'})),
    ];

    await expect(limiter.run(() => 'overflow', {key: 'k'})).rejects.toThrow(
      LimiterQueueFullError
    );

    gate.resolve();
    await settleAll(clock, [running, ...queued]);
  });

  it('names the key and says what to do about it', async () => {
    const {clock, limiter} = build(paced, {maxQueueDepth: 1});
    const first = ignore(limiter.run(() => 'x', {key: 'acct-9'}));
    const second = ignore(limiter.run(() => 'y', {key: 'acct-9'}));

    await expect(limiter.run(() => 'z', {key: 'acct-9'})).rejects.toThrow(/"acct-9"/);

    await settleAll(clock, [first, second]);
  });

  it('bounds the queue per key, not globally', async () => {
    const {clock, limiter} = build(paced, {maxQueueDepth: 1});
    const pending: Promise<unknown>[] = [];

    // Each key gets its own allowance: one running plus one queued.
    for (const key of ['a', 'b', 'c']) {
      pending.push(ignore(limiter.run(() => 'run', {key})));
      pending.push(ignore(limiter.run(() => 'queued', {key})));
    }

    expect(limiter.stats().queued).toBe(3);

    await settleAll(clock, pending);
  });

  it('accepts again once the queue drains', async () => {
    const {clock, limiter} = build(paced, {maxQueueDepth: 1});
    const first = ignore(limiter.run(() => 'x', {key: 'k'}));
    const second = ignore(limiter.run(() => 'y', {key: 'k'}));
    await expect(limiter.run(() => 'z', {key: 'k'})).rejects.toThrow(LimiterQueueFullError);

    await settleAll(clock, [first, second]);

    const later = limiter.run(() => 'later', {key: 'k'});
    await settleAll(clock, [later]);
    await expect(later).resolves.toBe('later');
  });
});

describe('MANDATORY 10 — scheduler wake-up behaviour', () => {
  it('sleeps exactly as long as the bucket says, with no polling', async () => {
    const {clock, limiter} = build(paced);
    const rec = recorder(clock);

    const calls = [
      limiter.run(rec.task('a'), {key: 'k'}),
      limiter.run(rec.task('b'), {key: 'k'}),
    ];

    // One pending timer, due at exactly the pacing interval.
    expect(clock.pendingTimers()).toBe(1);
    expect(clock.nextTimerAt()).toBe(100);

    await clock.advance(99);
    expect(rec.order).toEqual(['a']);

    await clock.advance(1);
    expect(rec.order).toEqual(['a', 'b']);
    expect(clock.pendingTimers()).toBe(0);

    await Promise.all(calls);
  });

  it('keeps at most one timer per key', async () => {
    const {clock, limiter} = build(paced);
    const calls = Array.from({length: 6}, () => limiter.run(() => 'x', {key: 'k'}));

    expect(clock.pendingTimers()).toBe(1);

    await clock.advance(100);
    expect(clock.pendingTimers()).toBe(1);

    await settleAll(clock, calls);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('sets no timer at all when the block is concurrency, not rate', async () => {
    const {clock, limiter} = build([{name: 'generous', limit: 1_000, interval: 'second'}], {
      maxConcurrent: 1,
    });
    const gate = deferred();
    const calls = [
      limiter.run(() => gate.promise),
      ignore(limiter.run(() => 'second')),
    ];

    // Waiting on a slot, not on time: a timer here would be a busy poll.
    expect(clock.pendingTimers()).toBe(0);

    gate.resolve();
    await clock.flush();
    await Promise.all(calls);
  });

  it('leaves no timer behind once every call has settled', async () => {
    const {clock, limiter} = build(paced);
    const calls = Array.from({length: 4}, () => limiter.run(() => 'x', {key: 'k'}));

    await settleAll(clock, calls);

    expect(clock.pendingTimers()).toBe(0);
    expect(limiter.stats()).toEqual({keys: 1, queued: 0, inflight: 0, backingOff: 0, decisionHookErrors: 0});
  });

  it('wakes a rate-blocked key and a slot-blocked key by their own signals', async () => {
    const {clock, limiter} = build(paced, {maxConcurrent: 1});
    const gate = deferred();
    const rec = recorder(clock);

    // 'a' holds the only slot. 'b' is behind both a slot and its own pacing.
    const holder = limiter.run(() => {
      rec.order.push('holder');
      return gate.promise;
    }, {key: 'a'});
    const waiter = limiter.run(rec.task('b'), {key: 'b'});

    expect(rec.order).toEqual(['holder']);

    gate.resolve();
    await settleAll(clock, [holder, waiter]);

    expect(rec.order).toEqual(['holder', 'b']);
  });
});

describe('MANDATORY 11 — queue liveness', () => {
  it('settles every call when tasks settle', async () => {
    const {clock, limiter} = build([{name: 'per-second', limit: 20, interval: 'second'}], {
      maxConcurrent: 3,
      maxConcurrentPerKey: 2,
    });

    const calls = Array.from({length: 60}, (_, index) =>
      limiter.run(async () => index, {key: `key-${index % 5}`, cost: (index % 3) + 1})
    );

    await settleAll(clock, calls);
    const results = await Promise.all(calls);

    expect(results).toHaveLength(60);
    expect(limiter.stats().queued).toBe(0);
    expect(limiter.stats().inflight).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('drains even when most tasks fail', async () => {
    const {clock, limiter} = build([{name: 'per-second', limit: 20, interval: 'second'}], {
      maxConcurrent: 2,
    });
    let settled = 0;

    const calls = Array.from({length: 40}, (_, index) =>
      limiter
        .run(async () => {
          if (index % 2 === 0) throw new Error('fail');
          return index;
        }, {key: `key-${index % 3}`})
        .then(
          () => settled++,
          () => settled++
        )
    );

    await settleAll(clock, calls);

    expect(settled).toBe(40);
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe('stats', () => {
  it('reports keys, queued and inflight', async () => {
    const {clock, limiter} = build(paced, {maxConcurrent: 1});
    const gate = deferred();

    const running = limiter.run(() => gate.promise, {key: 'a'});
    const queuedSameKey = limiter.run(() => 'x', {key: 'a'});
    const queuedOtherKey = limiter.run(() => 'y', {key: 'b'});

    expect(limiter.stats()).toEqual({keys: 2, queued: 2, inflight: 1, backingOff: 0, decisionHookErrors: 0});

    gate.resolve();
    await settleAll(clock, [running, queuedSameKey, queuedOtherKey]);

    expect(limiter.stats().queued).toBe(0);
    expect(limiter.stats().inflight).toBe(0);
  });
});

describe('registry exhaustion (MANDATORY 9)', () => {
  it('rejects a new key when none can be evicted safely', async () => {
    const {clock, limiter} = build(perSecond10, {maxKeys: 2, maxConcurrent: 10});
    const gates = [deferred(), deferred()];

    // Both keys hold running work, so neither is disposable.
    const held = [
      limiter.run(() => gates[0]!.promise, {key: 'a'}),
      limiter.run(() => gates[1]!.promise, {key: 'b'}),
    ];

    await expect(limiter.run(() => 'x', {key: 'c'})).rejects.toThrow(LimiterKeyLimitError);

    gates[0]?.resolve();
    gates[1]?.resolve();
    await settleAll(clock, held);
  });

  it('explains the usual cause rather than just failing', async () => {
    const {clock, limiter} = build(perSecond10, {maxKeys: 1});
    const gate = deferred();
    const held = limiter.run(() => gate.promise, {key: 'a'});

    await expect(limiter.run(() => 'x', {key: 'b'})).rejects.toThrow(/coarser key/);

    gate.resolve();
    await settleAll(clock, [held]);
  });

  it('accepts a new key once an old one becomes disposable', async () => {
    const {clock, limiter} = build(paced, {maxKeys: 1});

    await limiter.run(() => 'first', {key: 'a'});
    expect(limiter.stats().keys).toBe(1);

    // 'a' has spent its single token, so it is NOT yet disposable: evicting it
    // now would hand back capacity it has not paid for.
    await expect(limiter.run(() => 'too-soon', {key: 'b'})).rejects.toThrow(
      LimiterKeyLimitError
    );

    // After a full refill it carries no information, so it can go.
    await clock.advance(100);
    const revived = limiter.run(() => 'now-fine', {key: 'b'});
    await settleAll(clock, [revived]);
    await expect(revived).resolves.toBe('now-fine');
    expect(limiter.stats().keys).toBe(1);
  });
});
