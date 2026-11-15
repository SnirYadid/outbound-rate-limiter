/**
 * Decision telemetry, and the isolation that makes it safe to attach.
 *
 * Two halves. First the events: do they actually explain what happened, with
 * the constraint names, attempt numbers and delays an operator needs. Then the
 * isolation: a listener that throws, returns a rejected promise, re-enters the
 * limiter or tries to mutate an event must not be able to change any outcome.
 */

import {describe, expect, it} from 'vitest';

import {createEmitter, sealEvent} from '../src/telemetry.js';
import {createLimiter} from '../src/limiter.js';
import type {Decision, RateConstraint, RetryPolicy} from '../src/types.js';
import {createCountingClock} from './harness/counting-clock.js';
import {deferred, ignore} from './harness/deferred.js';
import {settleAll} from './harness/settle.js';
import {createVirtualClock} from './harness/virtual-clock.js';

const plenty: RateConstraint[] = [{name: 'plenty', limit: 10_000, interval: 'second'}];
const paced: RateConstraint[] = [{name: 'paced', limit: 10, interval: 'second', burst: 1}];

function watched(constraints: RateConstraint[] = plenty, extra: Record<string, unknown> = {}) {
  const clock = createVirtualClock(0);
  const events: Decision[] = [];
  const limiter = createLimiter({
    constraints,
    clock,
    onDecision: (event) => void events.push(event),
    ...extra,
  });
  return {clock, limiter, events, kinds: () => events.map((event) => event.kind)};
}

const fixed = (maxAttempts: number, delayMs: number): RetryPolicy => ({
  maxAttempts,
  jitter: 'none',
  baseDelayMs: delayMs,
  maxDelayMs: delayMs,
  classify: () => ({retry: true}),
});

describe('telemetry — the happy path', () => {
  it('explains a call that queued, started and completed', async () => {
    const {clock, limiter, events} = watched();
    const call = limiter.run(() => 'ok', {key: 'acct', cost: 2});
    await settleAll(clock, [call]);

    expect(events.map((event) => event.kind)).toEqual(['queued', 'admitted', 'completed']);
    expect(events[0]).toMatchObject({kind: 'queued', key: 'acct', depth: 1, scope: 'process'});
    expect(events[1]).toMatchObject({kind: 'admitted', attempt: 1, cost: 2, waitedMs: 0});
    expect(events[2]).toMatchObject({kind: 'completed', attempts: 1, elapsedMs: 0});
  });

  it('stamps every event with the clock, the key and the scope', async () => {
    const {clock, limiter, events} = watched();
    await clock.advance(1_234);
    const call = limiter.run(() => 'ok', {key: 'acct'});
    await settleAll(clock, [call]);

    for (const event of events) {
      expect(event.at).toBe(1_234);
      expect(event.key).toBe('acct');
      // On every event rather than only in the docs: these numbers describe
      // ONE process, and that is the thing most easily forgotten.
      expect(event.scope).toBe('process');
    }
  });

  it('emits nothing at all when no listener is attached', async () => {
    const clock = createVirtualClock(0);
    const limiter = createLimiter({constraints: plenty, clock});
    const call = limiter.run(() => 'ok');
    await settleAll(clock, [call]);

    expect(limiter.stats().decisionHookErrors).toBe(0);
  });
});

describe('telemetry — delays name what is blocking', () => {
  it('names the binding rate constraint and the wait', async () => {
    const {clock, limiter, events} = watched([
      {name: 'per-second', limit: 100, interval: 'second'},
      {name: 'per-minute', limit: 1, interval: 'minute', burst: 1},
    ]);

    const first = limiter.run(() => 'a', {key: 'k'});
    await settleAll(clock, [first]);
    events.length = 0;

    const second = limiter.run(() => 'b', {key: 'k'});
    await clock.flush();

    const delayed = events.find((event) => event.kind === 'delayed');
    expect(delayed).toMatchObject({
      kind: 'delayed',
      cause: 'rate',
      binding: 'per-minute',
      attempt: 0,
    });
    expect(delayed && 'waitMs' in delayed ? delayed.waitMs : 0).toBeGreaterThan(0);

    await settleAll(clock, [second]);
  });

  it('re-reports a delay every time the head is woken and is still blocked', async () => {
    // `delayed` counts WAIT DECISIONS, not calls. A rate-blocked head is woken
    // by every completion ahead of it, re-checks, finds the same wait and says
    // so again. That is honest — each wake really is a fresh decision — but a
    // listener that counts `delayed` events is not counting delayed calls.
    // Documented in GUARANTEES; pinned here so it cannot change silently.
    const {clock, limiter, events} = watched([
      {name: 'per-minute', limit: 2, interval: 'minute', burst: 2},
    ]);

    const gate = deferred();
    const calls = [
      limiter.run(() => gate.promise, {key: 'k'}),
      limiter.run(() => gate.promise, {key: 'k'}),
      // No capacity left for this one; it waits out the minute.
      limiter.run(() => 'third', {key: 'k'}),
    ];
    await clock.flush();

    const delaysBefore = events.filter((event) => event.kind === 'delayed').length;
    expect(delaysBefore).toBe(1);

    // Releasing the two in flight wakes the pump twice. Neither wake helps:
    // the block is capacity, and the clock has not moved.
    gate.resolve();
    await clock.flush();

    const delaysAfter = events.filter((event) => event.kind === 'delayed').length;
    expect(delaysAfter).toBeGreaterThan(delaysBefore);
    // Still ONE call waiting, however many delay events it produced.
    expect(limiter.stats().queued).toBe(1);

    await settleAll(clock, calls);
  });

  it('reports a global concurrency block, with a zero wait', async () => {
    const {clock, limiter, events} = watched(plenty, {maxConcurrent: 1});
    const gate = deferred();
    const holder = limiter.run(() => gate.promise, {key: 'a'});
    events.length = 0;

    const blocked = limiter.run(() => 'b', {key: 'b'});
    await clock.flush();

    expect(events.find((event) => event.kind === 'delayed')).toMatchObject({
      cause: 'concurrency',
      binding: 'maxConcurrent',
      // The wait depends on another call finishing, not on elapsed time, so
      // there is no honest number to report.
      waitMs: 0,
    });

    gate.resolve();
    await settleAll(clock, [holder, blocked]);
  });

  it('reports a per-key concurrency block', async () => {
    const {clock, limiter, events} = watched(plenty, {maxConcurrentPerKey: 1});
    const gate = deferred();
    const holder = limiter.run(() => gate.promise, {key: 'k'});
    events.length = 0;

    const blocked = limiter.run(() => 'b', {key: 'k'});
    await clock.flush();

    expect(events.find((event) => event.kind === 'delayed')).toMatchObject({
      cause: 'key-concurrency',
      binding: 'maxConcurrentPerKey',
      waitMs: 0,
    });

    gate.resolve();
    await settleAll(clock, [holder, blocked]);
  });

  it('never reports queued-ahead as a delay, since it is a refusal', async () => {
    const {clock, limiter, events} = watched(paced);
    const first = limiter.run(() => 'a', {key: 'k'});
    const queued = limiter.run(() => 'b', {key: 'k'});
    const refused = ignore(limiter.run(() => 'c', {key: 'k', onSaturated: 'reject'}));

    await settleAll(clock, [first, queued, refused]);

    for (const event of events) {
      if (event.kind === 'delayed') expect(event.cause).not.toBe('queued-ahead');
    }
    expect(events.filter((event) => event.kind === 'refused')).toContainEqual(
      expect.objectContaining({reason: 'saturated'})
    );
  });
});

describe('telemetry — retries and refusals', () => {
  it('reports each retry with its delay and where the delay came from', async () => {
    const {clock, limiter, events} = watched();
    let attempts = 0;

    const call = limiter.run(
      () => {
        attempts++;
        if (attempts < 3) throw new Error('again');
        return 'ok';
      },
      {key: 'k', retry: fixed(5, 150)}
    );
    await settleAll(clock, [call]);

    const retrying = events.filter((event) => event.kind === 'retrying');
    expect(retrying).toHaveLength(2);
    expect(retrying[0]).toMatchObject({attempt: 1, delayMs: 150, source: 'backoff'});
    expect(retrying[1]).toMatchObject({attempt: 2, delayMs: 150, source: 'backoff'});
    expect(events.at(-1)).toMatchObject({kind: 'completed', attempts: 3});
  });

  it('marks a provider hint as its own source', async () => {
    const {clock, limiter, events} = watched();
    let attempts = 0;

    const call = limiter.run(
      () => {
        attempts++;
        if (attempts < 2) throw new Error('throttled');
        return 'ok';
      },
      {key: 'k', retry: {maxAttempts: 3, classify: () => ({retry: true, afterMs: 400})}}
    );
    await settleAll(clock, [call]);

    expect(events.find((event) => event.kind === 'retrying')).toMatchObject({
      delayMs: 400,
      source: 'provider-hint',
    });
  });

  it.each<[string, RefusalCase]>([
    [
      'attempts',
      {
        options: {retry: fixed(2, 10)},
        task: () => {
          throw new Error('always');
        },
      },
    ],
    [
      'not-retryable',
      {
        options: {retry: {maxAttempts: 5, classify: () => ({retry: false})}},
        task: () => {
          throw new Error('permanent');
        },
      },
    ],
    [
      'error',
      {
        options: {},
        task: () => {
          throw new Error('no policy');
        },
      },
    ],
    [
      'budget',
      {
        options: {totalBudgetMs: 50, retry: fixed(10, 100)},
        task: () => {
          throw new Error('again');
        },
      },
    ],
  ])('reports a refusal reason of %s', async (reason, testCase) => {
    const {clock, limiter, events} = watched();
    const call = ignore(limiter.run(testCase.task, {key: 'k', ...testCase.options}));
    await settleAll(clock, [call]);

    expect(events.at(-1)).toMatchObject({kind: 'refused', reason});
  });

  it('reports a timeout refusal', async () => {
    const {clock, limiter, events} = watched();
    const call = ignore(
      limiter.run(() => new Promise<string>(() => undefined), {key: 'k', attemptTimeoutMs: 100})
    );
    await clock.advance(100);
    await call;

    expect(events.at(-1)).toMatchObject({kind: 'refused', reason: 'timeout', attempts: 1});
  });

  it('reports a cancellation as a refusal, with attempts so far', async () => {
    const {clock, limiter, events} = watched();
    const controller = new AbortController();

    const call = ignore(
      limiter.run(() => new Promise<string>(() => undefined), {
        key: 'k',
        signal: controller.signal,
      })
    );
    controller.abort();
    await call;

    expect(events.at(-1)).toMatchObject({kind: 'refused', reason: 'aborted', attempts: 1});
    await clock.flush();
  });

  it('reports a queue-full refusal with zero attempts', async () => {
    const {clock, limiter, events} = watched(paced, {maxQueueDepth: 1});
    const running = limiter.run(() => 'a', {key: 'k'});
    const queued = ignore(limiter.run(() => 'b', {key: 'k'}));
    const refused = ignore(limiter.run(() => 'c', {key: 'k'}));

    expect(events.find((event) => event.kind === 'refused')).toMatchObject({
      reason: 'queue-full',
      attempts: 0,
    });

    await settleAll(clock, [running, queued, refused]);
  });

  it('reports a key-limit refusal', async () => {
    const {clock, limiter, events} = watched(plenty, {maxKeys: 1});
    const gate = deferred();
    const holder = limiter.run(() => gate.promise, {key: 'a'});
    const refused = ignore(limiter.run(() => 'x', {key: 'b'}));
    await refused;

    expect(events.find((event) => event.kind === 'refused')).toMatchObject({
      reason: 'key-limit',
      attempts: 0,
    });

    gate.resolve();
    await settleAll(clock, [holder]);
  });

  it('reports a pre-aborted call as aborted with zero attempts', async () => {
    const {limiter, events} = watched();
    const controller = new AbortController();
    controller.abort();

    await ignore(limiter.run(() => 'x', {key: 'k', signal: controller.signal}));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({kind: 'refused', reason: 'aborted', attempts: 0});
  });
});

interface RefusalCase {
  readonly options: Record<string, unknown>;
  readonly task: () => unknown;
}

describe('telemetry — immutability', () => {
  it('hands out frozen events', async () => {
    const {clock, limiter, events} = watched();
    const call = limiter.run(() => 'ok', {key: 'k'});
    await settleAll(clock, [call]);

    for (const event of events) {
      expect(Object.isFrozen(event)).toBe(true);
      expect(() => {
        (event as {key: string}).key = 'tampered';
      }).toThrow();
    }
  });

  it('hands out frozen events for every one of the six kinds', async () => {
    // The test above covers one happy path, which produces three kinds. The
    // other three are emitted from different call sites, and each site seals
    // its own event — so a site that forgot would weaken T2 for that kind
    // alone. This drives all six and checks the lot.
    const collected: Decision[] = [];
    const tight: RateConstraint[] = [{name: 'tight', limit: 1, interval: 'minute', burst: 1}];

    // queued, admitted, completed, delayed, retrying.
    const first = watched(tight, {maxQueueDepth: 1});
    const failing = ignore(
      first.limiter.run(
        () => {
          throw new Error('transient');
        },
        {key: 'k', retry: fixed(2, 10)}
      )
    );
    const behind = ignore(first.limiter.run(() => 'behind', {key: 'k'}));
    await settleAll(first.clock, [failing, behind]);
    collected.push(...first.events);

    // refused.
    const second = watched(tight);
    const taken = second.limiter.run(() => 'got-it', {key: 'k'});
    await settleAll(second.clock, [taken]);
    const rejected = ignore(
      second.limiter.run(() => 'no', {key: 'k', onSaturated: 'reject'})
    );
    await settleAll(second.clock, [rejected]);
    collected.push(...second.events);

    const kinds = new Set(collected.map((event) => event.kind));
    expect([...kinds].sort()).toEqual([
      'admitted',
      'completed',
      'delayed',
      'queued',
      'refused',
      'retrying',
    ]);

    for (const event of collected) {
      expect(Object.isFrozen(event), `${event.kind} must be frozen`).toBe(true);
      expect(() => {
        (event as {key: string}).key = 'tampered';
      }, `${event.kind} must reject mutation`).toThrow();
    }
  });

  it('carries only primitives, which is what makes a shallow freeze complete', async () => {
    // The structural reason `Object.freeze` is sufficient: there is no nested
    // object for a listener to reach through and mutate.
    const {clock, limiter, events} = watched(paced, {maxConcurrent: 1});
    let attempts = 0;
    const call = ignore(
      limiter.run(
        () => {
          attempts++;
          if (attempts < 2) throw new Error('again');
          return 'ok';
        },
        {key: 'k', retry: fixed(3, 50)}
      )
    );
    await settleAll(clock, [call]);

    expect(events.length).toBeGreaterThan(3);
    for (const event of events) {
      for (const [field, value] of Object.entries(event)) {
        expect(
          ['string', 'number', 'boolean', 'undefined'].includes(typeof value),
          `${event.kind}.${field} must be a primitive, saw ${typeof value}`
        ).toBe(true);
      }
    }
  });

  it('never exposes the error that caused a retry or a refusal', async () => {
    // Deliberate: the classifier already saw the error. Putting it here would
    // route request payloads into whatever consumes telemetry.
    const {clock, limiter, events} = watched();
    const secret = new Error('token=abc123 should never appear in telemetry');

    const call = ignore(
      limiter.run(
        () => {
          throw secret;
        },
        {key: 'k', retry: fixed(2, 10)}
      )
    );
    await settleAll(clock, [call]);

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('abc123');
    expect(serialized).not.toContain('should never appear');
  });
});

describe('telemetry — listener failure isolation', () => {
  it('a throwing listener does not affect the task’s result', async () => {
    const clock = createVirtualClock(0);
    const limiter = createLimiter({
      constraints: plenty,
      clock,
      onDecision: () => {
        throw new Error('listener is broken');
      },
    });

    const call = limiter.run(() => 'unaffected', {key: 'k'});
    await settleAll(clock, [call]);

    await expect(call).resolves.toBe('unaffected');
    // Counted rather than logged, so the failure is visible but silenceable.
    expect(limiter.stats().decisionHookErrors).toBeGreaterThan(0);
  });

  it('a throwing listener does not abandon the queue', async () => {
    const clock = createVirtualClock(0);
    const limiter = createLimiter({
      constraints: paced,
      clock,
      onDecision: () => {
        throw new Error('always');
      },
    });

    // If a listener throw escaped into the pump, the loop would abandon the
    // rest of the queue and these would never run.
    const calls = Array.from({length: 5}, (_, index) => limiter.run(() => index, {key: 'k'}));
    await settleAll(clock, calls);

    expect(await Promise.all(calls)).toEqual([0, 1, 2, 3, 4]);
    expect(limiter.stats()).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
  });

  it('an async listener returning a rejected promise is absorbed and counted', async () => {
    // Left alone this would be an unhandled rejection, which can take a
    // process down on `--unhandled-rejections=strict`.
    const clock = createVirtualClock(0);
    const limiter = createLimiter({
      constraints: plenty,
      clock,
      onDecision: (): void => {
         
        return Promise.reject(new Error('async listener failed')) as unknown as void;
      },
    });

    const call = limiter.run(() => 'ok', {key: 'k'});
    await settleAll(clock, [call]);
    await clock.flush();

    await expect(call).resolves.toBe('ok');
    expect(limiter.stats().decisionHookErrors).toBeGreaterThan(0);
  });

  it('an async listener that resolves is not counted as a failure', async () => {
    const clock = createVirtualClock(0);
    const limiter = createLimiter({
      constraints: plenty,
      clock,
      onDecision: (): void => Promise.resolve() as unknown as void,
    });

    const call = limiter.run(() => 'ok', {key: 'k'});
    await settleAll(clock, [call]);
    await clock.flush();

    expect(limiter.stats().decisionHookErrors).toBe(0);
  });

  it('counts every failure, not just the first', async () => {
    const clock = createVirtualClock(0);
    let seen = 0;
    const limiter = createLimiter({
      constraints: plenty,
      clock,
      onDecision: () => {
        seen++;
        throw new Error('always');
      },
    });

    const call = limiter.run(() => 'ok', {key: 'k'});
    await settleAll(clock, [call]);

    // queued, admitted, completed.
    expect(seen).toBe(3);
    expect(limiter.stats().decisionHookErrors).toBe(3);
  });
});

describe('telemetry — reentrancy', () => {
  it('a listener that submits more work does not recurse without bound', async () => {
    const clock = createVirtualClock(0);
    const events: Decision[] = [];
    let depth = 0;
    let maxDepth = 0;
    const limiter: ReturnType<typeof createLimiter> = createLimiter({
      constraints: plenty,
      clock,
      onDecision: (event) => {
        events.push(event);
        depth++;
        maxDepth = Math.max(maxDepth, depth);
        // Re-entering the limiter from inside a listener. Nested events are
        // buffered and flushed by the outer emit, so depth stays at one.
        if (events.length < 6 && event.kind === 'queued') {
          void ignore(limiter.run(() => 'nested', {key: 'nested', onSaturated: 'reject'}));
        }
        depth--;
      },
    });

    const call = limiter.run(() => 'outer', {key: 'outer'});
    await settleAll(clock, [call]);

    expect(maxDepth).toBe(1);
    await expect(call).resolves.toBe('outer');
  });

  it('a listener can read stats and inspect without disturbing anything', async () => {
    const clock = createVirtualClock(0);
    const observed: number[] = [];
    const limiter: ReturnType<typeof createLimiter> = createLimiter({
      constraints: paced,
      clock,
      onDecision: () => {
        observed.push(limiter.inspect('k').constraints[0]!.available);
        limiter.stats();
      },
    });

    const admittedAt: number[] = [];
    const calls = Array.from({length: 3}, () =>
      limiter.run(() => void admittedAt.push(clock.now()), {key: 'k'})
    );
    await settleAll(clock, calls);

    // The listener read state on every event and the pacing is unchanged.
    expect(admittedAt).toEqual([0, 100, 200]);
    expect(observed.length).toBeGreaterThan(0);
  });

  it('a listener observing an admitted event sees capacity already spent', async () => {
    // The emit-after-commit rule: a listener never catches a half-made
    // decision.
    const clock = createVirtualClock(0);
    const seenAtAdmission: number[] = [];
    const limiter: ReturnType<typeof createLimiter> = createLimiter({
      constraints: [{name: 'c', limit: 10, interval: 'minute', burst: 10}],
      clock,
      onDecision: (event) => {
        if (event.kind === 'admitted') {
          seenAtAdmission.push(limiter.inspect('k').constraints[0]!.available);
        }
      },
    });

    const call = limiter.run(() => 'ok', {key: 'k', cost: 3});
    await settleAll(clock, [call]);

    // 10 - 3: the debit is already visible when the event arrives.
    expect(seenAtAdmission).toEqual([7]);
  });
});

describe('telemetry — costs nothing when nobody is watching', () => {
  /**
   * `LimiterOptions.onDecision` is documented as being on the hot path, and the
   * emitter exposes `active` so callers can skip building an event nobody will
   * read. These tests hold the library to that, differentially: the same
   * schedule is run with and without a listener, and the clock counts how often
   * it was read. Building an event stamps `at` from the clock, so a discarded
   * event is a measurable extra read.
   */

  /**
   * `onSaturated: 'reject'` on an idle key is the one path where every event
   * comes from `call.ts`: admission succeeds without the queue, so there is no
   * `queued` event from the limiter and the pump never runs. Comparing clock
   * reads across that path therefore isolates `call.ts`'s own gating instead of
   * measuring the limiter's and the scheduler's, which are already lazy.
   */
  const readsForRejectPath = async (
    listener: ((event: Decision) => void) | undefined
  ): Promise<number> => {
    const clock = createCountingClock(0);
    const limiter = createLimiter({
      constraints: plenty,
      clock,
      ...(listener === undefined ? {} : {onDecision: listener}),
    });
    clock.resetReads();
    const call = limiter.run(() => 'ok', {key: 'k', onSaturated: 'reject'});
    await settleAll(clock, [call]);
    return clock.reads();
  };

  // This was `it.fails` until `emitter.publish(build)` landed: `call.ts` used
  // to build the event and only then check whether anybody was listening, so
  // the reads came out equal. Now the builder is a thunk the emitter never
  // invokes when inactive.
  it('reads the clock less when no listener is attached', async () => {
    const withListener = await readsForRejectPath(() => undefined);
    const without = await readsForRejectPath(undefined);

    // Equal counts mean the `admitted` and `completed` events are being built
    // and then thrown away, which is what `Emitter.active` exists to prevent.
    expect(without).toBeLessThan(withListener);
  });

  it('stays lazy on the queued path too', async () => {
    const readsForQueue = async (
      listener: ((event: Decision) => void) | undefined
    ): Promise<number> => {
      const clock = createCountingClock(0);
      const limiter = createLimiter({
        constraints: paced,
        clock,
        ...(listener === undefined ? {} : {onDecision: listener}),
      });
      clock.resetReads();
      const calls = [
        ignore(limiter.run(() => 'a', {key: 'k'})),
        ignore(limiter.run(() => 'b', {key: 'k'})),
        ignore(
          limiter.run(
            () => {
              throw new Error('transient');
            },
            {key: 'k', retry: fixed(2, 50)}
          )
        ),
      ];
      await settleAll(clock, calls);
      return clock.reads();
    };

    expect(await readsForQueue(undefined)).toBeLessThan(await readsForQueue(() => undefined));
  });

  it('produces identical results with and without a listener', async () => {
    // The laziness above must be invisible in behaviour: same admissions, same
    // pacing, same outcomes.
    const run = async (listener: ((event: Decision) => void) | undefined) => {
      const clock = createVirtualClock(0);
      const admittedAt: number[] = [];
      const limiter = createLimiter({
        constraints: paced,
        clock,
        ...(listener === undefined ? {} : {onDecision: listener}),
      });
      const calls = Array.from({length: 4}, (_, index) =>
        limiter.run(() => void admittedAt.push(clock.now()), {key: 'k', cost: index === 3 ? 1 : 1})
      );
      await settleAll(clock, calls);
      return {admittedAt, stats: limiter.stats()};
    };

    const watchedRun = await run(() => undefined);
    const quietRun = await run(undefined);

    expect(quietRun.admittedAt).toEqual(watchedRun.admittedAt);
    expect(quietRun.stats).toEqual({...watchedRun.stats, decisionHookErrors: 0});
  });
});

describe('emitter — unit', () => {
  it('is inert without a listener, and never calls the builder', () => {
    // The gate is the emitter's own business now, so this asserts the
    // behaviour rather than a flag: `publish` must discard its builder
    // unevaluated, which is what makes telemetry free when nobody watches.
    const emitter = createEmitter(undefined);
    let built = 0;

    emitter.publish(() => {
      built++;
      return {at: 0, key: 'k', scope: 'process', kind: 'queued', depth: 1};
    });
    emitter.emit(sealEvent({at: 0, key: 'k', scope: 'process', kind: 'queued', depth: 1}));

    expect(built).toBe(0);
    expect(emitter.failures).toBe(0);
  });

  it('calls the builder exactly once per publish, and seals the result', () => {
    const seen: Decision[] = [];
    const emitter = createEmitter((event) => void seen.push(event));
    let built = 0;

    emitter.publish(() => {
      built++;
      // Deliberately NOT pre-sealed: sealing is the emitter's job.
      return {at: 7, key: 'k', scope: 'process', kind: 'queued', depth: 2};
    });

    expect(built).toBe(1);
    expect(seen).toHaveLength(1);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(seen[0]).toMatchObject({at: 7, depth: 2});
  });

  it('flushes nested emissions in order after the outer call', () => {
    const order: string[] = [];
    const emitter: ReturnType<typeof createEmitter> = createEmitter((event) => {
      order.push(`enter:${event.kind}`);
      if (event.kind === 'queued') {
        emitter.emit(sealEvent({at: 0, key: 'k', scope: 'process', kind: 'completed', attempts: 1, elapsedMs: 0}));
        // The nested event has NOT been delivered yet at this point.
        expect(order).toEqual(['enter:queued']);
      }
      order.push(`exit:${event.kind}`);
    });

    emitter.emit(sealEvent({at: 0, key: 'k', scope: 'process', kind: 'queued', depth: 1}));

    expect(order).toEqual(['enter:queued', 'exit:queued', 'enter:completed', 'exit:completed']);
  });

  it('delivers buffered nested events frozen, exactly as it delivers direct ones', () => {
    // Sealing and buffering are independent today — the caller seals, the
    // emitter buffers — so nothing stops a future emitter from flushing its
    // buffer by a route that skips the seal. This pins the property at the
    // boundary a listener actually observes.
    const frozen: boolean[] = [];
    const emitter: ReturnType<typeof createEmitter> = createEmitter((event) => {
      frozen.push(Object.isFrozen(event));
      if (event.kind === 'queued') {
        emitter.emit(
          sealEvent({at: 0, key: 'k', scope: 'process', kind: 'completed', attempts: 1, elapsedMs: 0})
        );
      }
    });

    emitter.emit(sealEvent({at: 0, key: 'k', scope: 'process', kind: 'queued', depth: 1}));

    // The direct delivery and the flushed nested one.
    expect(frozen).toEqual([true, true]);
  });

  it('keeps delivering after a listener throws', () => {
    const seen: string[] = [];
    const emitter = createEmitter((event) => {
      seen.push(event.kind);
      throw new Error('always');
    });

    emitter.emit(sealEvent({at: 0, key: 'k', scope: 'process', kind: 'queued', depth: 1}));
    emitter.emit(sealEvent({at: 1, key: 'k', scope: 'process', kind: 'completed', attempts: 1, elapsedMs: 0}));

    expect(seen).toEqual(['queued', 'completed']);
    expect(emitter.failures).toBe(2);
  });
});
