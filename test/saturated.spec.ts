/**
 * `onSaturated: 'reject'` — start now, or fail now.
 *
 * The contract being pinned: the call is never queued, so it takes no
 * capacity, no concurrency slot and no timer, and the promise always settles.
 * Each refusal kind is distinguishable, because each one clears for a
 * different reason.
 */

import {describe, expect, it} from 'vitest';

import {LimiterConfigError, LimiterSaturatedError} from '../src/errors.js';
import {createLimiter} from '../src/limiter.js';
import type {RateConstraint, SaturationKind} from '../src/types.js';
import {deferred, ignore} from './harness/deferred.js';
import {settleAll} from './harness/settle.js';
import {createVirtualClock} from './harness/virtual-clock.js';

const paced: RateConstraint[] = [{name: 'paced', limit: 10, interval: 'second', burst: 1}];
const generous: RateConstraint[] = [{name: 'generous', limit: 10_000, interval: 'second'}];

function build(constraints: RateConstraint[], extra: Record<string, unknown> = {}) {
  const clock = createVirtualClock(0);
  return {clock, limiter: createLimiter({constraints, clock, ...extra})};
}

/** Reads the refusal off a rejected call. */
async function refusal(promise: Promise<unknown>): Promise<LimiterSaturatedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LimiterSaturatedError) return error;
    throw error;
  }
  throw new Error('expected the call to be refused, but it resolved');
}

describe('onSaturated — defaults and validation', () => {
  it('defaults to waiting, which is the existing behaviour', async () => {
    const {clock, limiter} = build(paced);
    const calls = [limiter.run(() => 'a', {key: 'k'}), limiter.run(() => 'b', {key: 'k'})];

    await settleAll(clock, calls);

    // Both resolve: the second waited rather than being refused.
    await expect(Promise.all(calls)).resolves.toEqual(['a', 'b']);
  });

  it("'wait' stated explicitly behaves identically to the default", async () => {
    const {clock, limiter} = build(paced);
    const calls = [
      limiter.run(() => 'a', {key: 'k', onSaturated: 'wait'}),
      limiter.run(() => 'b', {key: 'k', onSaturated: 'wait'}),
    ];

    await settleAll(clock, calls);
    await expect(Promise.all(calls)).resolves.toEqual(['a', 'b']);
  });

  it('rejects an unknown policy synchronously', () => {
    const {limiter} = build(paced);
    expect(() =>
      limiter.run(() => 'x', {onSaturated: 'maybe' as unknown as 'wait'})
    ).toThrow(LimiterConfigError);
  });

  it('runs immediately when there is capacity', async () => {
    const {limiter} = build(generous);
    await expect(limiter.run(() => 'ok', {onSaturated: 'reject'})).resolves.toBe('ok');
  });
});

describe('onSaturated: reject — rate saturation', () => {
  it('refuses with kind "rate" and the binding constraint', async () => {
    const {clock, limiter} = build(paced);
    const first = limiter.run(() => 'a', {key: 'k'});
    await settleAll(clock, [first]);

    const error = await refusal(limiter.run(() => 'b', {key: 'k', onSaturated: 'reject'}));

    expect(error.kind).toBe('rate');
    expect(error.binding).toBe('paced');
    expect(error.waitMs).toBeGreaterThan(0);
    expect(error.key).toBe('k');
  });

  it('consumes no capacity, so a later waiting call is not delayed', async () => {
    const {clock, limiter} = build(paced);
    const admittedAt: number[] = [];

    const first = limiter.run(() => void admittedAt.push(clock.now()), {key: 'k'});
    await settleAll(clock, [first]);

    // Refuse three times. If any of them took capacity, the waiting call
    // below would start later than one pacing interval after the first.
    for (let i = 0; i < 3; i++) {
      await refusal(limiter.run(() => 'no', {key: 'k', onSaturated: 'reject'}));
    }

    const waiting = limiter.run(() => void admittedAt.push(clock.now()), {key: 'k'});
    await settleAll(clock, [waiting]);

    expect(admittedAt).toEqual([0, 100]);
  });

  it('names the slowest constraint under a multi-constraint configuration', async () => {
    const {clock, limiter} = build([
      {name: 'per-second', limit: 50, interval: 'second'},
      {name: 'per-minute', limit: 3, interval: 'minute', burst: 3},
    ]);

    const warmup = Array.from({length: 3}, (_, i) => limiter.run(() => i, {key: 'k'}));
    await settleAll(clock, warmup);

    const error = await refusal(limiter.run(() => 'x', {key: 'k', onSaturated: 'reject'}));

    expect(error.kind).toBe('rate');
    expect(error.binding).toBe('per-minute');
  });

  it('leaves no timer behind when it refuses', async () => {
    const {clock, limiter} = build(paced);
    const first = limiter.run(() => 'a', {key: 'k'});
    await settleAll(clock, [first]);
    expect(clock.pendingTimers()).toBe(0);

    await refusal(limiter.run(() => 'b', {key: 'k', onSaturated: 'reject'}));

    // A refused call is never queued, so nothing is waiting on the clock.
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe('onSaturated: reject — global concurrency saturation', () => {
  it('refuses with kind "concurrency" naming maxConcurrent', async () => {
    const {clock, limiter} = build(generous, {maxConcurrent: 1});
    const gate = deferred();
    const held = limiter.run(() => gate.promise, {key: 'a'});

    const error = await refusal(limiter.run(() => 'x', {key: 'b', onSaturated: 'reject'}));

    expect(error.kind).toBe('concurrency');
    expect(error.binding).toBe('maxConcurrent');
    expect(error.waitMs).toBe(0);
    expect(error.message).toMatch(/maxConcurrent = 1/);

    gate.resolve();
    await settleAll(clock, [held]);
  });

  it('leaks no slot: the limiter still works after a refusal', async () => {
    const {clock, limiter} = build(generous, {maxConcurrent: 1});
    const gate = deferred();
    const held = limiter.run(() => gate.promise, {key: 'a'});

    for (let i = 0; i < 5; i++) {
      await refusal(limiter.run(() => 'x', {key: 'b', onSaturated: 'reject'}));
    }
    expect(limiter.stats().inflight).toBe(1);

    gate.resolve();
    await settleAll(clock, [held]);

    expect(limiter.stats().inflight).toBe(0);
    await expect(limiter.run(() => 'after', {onSaturated: 'reject'})).resolves.toBe('after');
  });
});

describe('onSaturated: reject — per-key concurrency saturation', () => {
  it('refuses with kind "key-concurrency" naming maxConcurrentPerKey', async () => {
    const {clock, limiter} = build(generous, {maxConcurrentPerKey: 1});
    const gate = deferred();
    const held = limiter.run(() => gate.promise, {key: 'a'});

    const error = await refusal(limiter.run(() => 'x', {key: 'a', onSaturated: 'reject'}));

    expect(error.kind).toBe('key-concurrency');
    expect(error.binding).toBe('maxConcurrentPerKey');
    expect(error.message).toMatch(/maxConcurrentPerKey = 1/);

    gate.resolve();
    await settleAll(clock, [held]);
  });

  it('refuses one key while another key is still admitted', async () => {
    const {clock, limiter} = build(generous, {maxConcurrentPerKey: 1});
    const gate = deferred();
    const held = limiter.run(() => gate.promise, {key: 'a'});

    await refusal(limiter.run(() => 'x', {key: 'a', onSaturated: 'reject'}));
    // A different key has its own allowance, so this must succeed.
    await expect(limiter.run(() => 'y', {key: 'b', onSaturated: 'reject'})).resolves.toBe('y');

    gate.resolve();
    await settleAll(clock, [held]);
  });
});

describe('onSaturated: reject — an existing backlog', () => {
  it('refuses with kind "queued-ahead" rather than jumping the queue', async () => {
    const {clock, limiter} = build(paced);
    const first = limiter.run(() => 'a', {key: 'k'});
    const queued = limiter.run(() => 'b', {key: 'k'});

    expect(limiter.stats().queued).toBe(1);

    const error = await refusal(limiter.run(() => 'c', {key: 'k', onSaturated: 'reject'}));

    expect(error.kind).toBe('queued-ahead');
    expect(error.binding).toBe('queue');
    expect(error.message).toMatch(/already has 1 call\(s\) queued/);
    expect(error.message).toMatch(/FIFO/);

    await settleAll(clock, [first, queued]);
  });

  it('NEVER starts ahead of a queued call it could have overtaken', async () => {
    // The case that makes the backlog check load-bearing rather than
    // defensive: a cheap call IS admissible while an expensive queued call is
    // not. Without the check, a stream of cheap rejecting calls would starve
    // the expensive one indefinitely.
    const {clock, limiter} = build([{name: 'wide', limit: 10, interval: 'second', burst: 10}]);
    const order: string[] = [];

    // Drain to 0, then queue a cost-10 call: it needs a full second.
    const drain = limiter.run(() => void order.push('drain'), {key: 'k', cost: 10});
    await settleAll(clock, [drain]);
    const expensive = limiter.run(() => void order.push('expensive'), {key: 'k', cost: 10});

    // 300ms later there are 3 tokens — enough for a cost-1 call.
    await clock.advance(300);
    const error = await refusal(
      limiter.run(() => void order.push('cheap'), {key: 'k', cost: 1, onSaturated: 'reject'})
    );
    expect(error.kind).toBe('queued-ahead');

    await settleAll(clock, [expensive]);

    // 'cheap' never ran, and did not delay 'expensive'.
    expect(order).toEqual(['drain', 'expensive']);
  });

  it('accepts again once the backlog has drained', async () => {
    const {clock, limiter} = build(paced);
    const first = limiter.run(() => 'a', {key: 'k'});
    const queued = limiter.run(() => 'b', {key: 'k'});
    await refusal(limiter.run(() => 'c', {key: 'k', onSaturated: 'reject'}));

    await settleAll(clock, [first, queued]);
    await clock.advance(100);

    await expect(limiter.run(() => 'd', {key: 'k', onSaturated: 'reject'})).resolves.toBe('d');
  });

  it('a backlog on one key does not refuse a different key', async () => {
    const {clock, limiter} = build(paced);
    const busy = [limiter.run(() => 'a', {key: 'busy'}), limiter.run(() => 'b', {key: 'busy'})];

    await expect(limiter.run(() => 'free', {key: 'other', onSaturated: 'reject'})).resolves.toBe(
      'free'
    );

    await settleAll(clock, busy);
  });
});

describe('onSaturated: reject — hygiene', () => {
  it('propagates the task’s own error rather than a refusal', async () => {
    const {limiter} = build(generous);
    const boom = new Error('task failed');

    await expect(
      limiter.run(() => {
        throw boom;
      }, {onSaturated: 'reject'})
    ).rejects.toBe(boom);
    expect(limiter.stats().inflight).toBe(0);
  });

  it('settles every refusal, leaving nothing queued or in flight', async () => {
    const {clock, limiter} = build(paced, {maxConcurrent: 1});
    const kinds: SaturationKind[] = [];

    const first = limiter.run(() => 'a', {key: 'k'});
    await settleAll(clock, [first]);

    for (let i = 0; i < 10; i++) {
      kinds.push((await refusal(limiter.run(() => 'x', {key: 'k', onSaturated: 'reject'}))).kind);
    }

    expect(new Set(kinds)).toEqual(new Set(['rate']));
    expect(limiter.stats()).toEqual({keys: 1, queued: 0, inflight: 0, backingOff: 0, decisionHookErrors: 0});
    expect(clock.pendingTimers()).toBe(0);
  });

  it('mixes rejecting and waiting callers on the same key without disorder', async () => {
    const {clock, limiter} = build(paced);
    const order: string[] = [];

    const waiting = [
      limiter.run(() => void order.push('w1'), {key: 'k'}),
      limiter.run(() => void order.push('w2'), {key: 'k'}),
      limiter.run(() => void order.push('w3'), {key: 'k'}),
    ];
    // Every rejecting caller is refused: there is a backlog the whole time.
    const refused = Array.from({length: 3}, () =>
      ignore(limiter.run(() => void order.push('r'), {key: 'k', onSaturated: 'reject'}))
    );

    await settleAll(clock, [...waiting, ...refused]);

    expect(order).toEqual(['w1', 'w2', 'w3']);
  });
});
