/**
 * The per-call `cost` contract, at its boundaries.
 *
 * The established semantics, audited rather than changed: `cost` must be a
 * finite number greater than zero and no greater than every constraint's
 * `burst`. Fractional costs are allowed. Anything else throws
 * `QuotaPilotConfigError` SYNCHRONOUSLY from `run()`.
 *
 * Synchronously, and not as a rejection, for one reason: a cost that no
 * constraint could ever admit would otherwise be a promise that never settles.
 * A deterministic throw at the call site beats an unkillable hang.
 */

import {describe, expect, it} from 'vitest';

import {TOKEN_EPSILON} from '../src/bucket.js';
import {QuotaPilotConfigError} from '../src/errors.js';
import {createLimiter} from '../src/limiter.js';
import type {RateConstraint} from '../src/types.js';
import {settleAll} from './harness/settle.js';
import {createVirtualClock} from './harness/virtual-clock.js';

const tenPerSecond: RateConstraint[] = [{name: 'per-second', limit: 10, interval: 'second'}];

function build(constraints: RateConstraint[] = tenPerSecond) {
  const clock = createVirtualClock(0);
  return {clock, limiter: createLimiter({constraints, clock})};
}

describe('cost — rejected values', () => {
  it.each<[string, unknown]>([
    ['zero', 0],
    ['negative zero', -0],
    ['negative', -1],
    ['negative fraction', -0.5],
    ['NaN', Number.NaN],
    ['positive Infinity', Number.POSITIVE_INFINITY],
    ['negative Infinity', Number.NEGATIVE_INFINITY],
    ['a numeric string', '2'],
    ['a boolean', true],
    ['an object', {}],
    ['an array', [1]],
  ])('throws synchronously for %s', (_label, cost) => {
    const {limiter} = build();
    expect(() => limiter.run(() => 'x', {cost: cost as number})).toThrow(QuotaPilotConfigError);
  });

  it('throws rather than returning a rejected promise', () => {
    // Pinned explicitly: a caller writing `limiter.run(...).catch(...)` must
    // not be lulled into thinking the bad cost was handled.
    const {limiter} = build();
    let threw = false;
    try {
      void limiter.run(() => 'x', {cost: 0});
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('names the offending value in the message', () => {
    const {limiter} = build();
    expect(() => limiter.run(() => 'x', {cost: -3})).toThrow(/received -3/);
  });

  it('treats an omitted, null or undefined cost alike as "use the default"', async () => {
    // `cost` is defaulted with `??`, so both nullish values mean absent — the
    // same reading `key` uses. Distinguishing null from undefined here would
    // be inconsistent with the rest of the options and would add a restriction
    // the contract never had.
    //
    // Both casts are deliberate. Under `exactOptionalPropertyTypes` a TS
    // caller cannot even write `{cost: undefined}`, so these two values are
    // only reachable from untyped JavaScript — which is exactly the caller
    // this behaviour exists for.
    const {clock, limiter} = build();
    const calls = [
      limiter.run(() => 'a', {key: 'k'}),
      limiter.run(() => 'b', {key: 'k', cost: undefined as unknown as number}),
      limiter.run(() => 'c', {key: 'k', cost: null as unknown as number}),
    ];
    await settleAll(clock, calls);

    // Three default-cost calls debited 3 of 10.
    expect(limiter.inspect('k').constraints[0]!.available).toBe(7);
  });
});

describe('cost — the burst boundary', () => {
  it('admits a cost exactly equal to burst', async () => {
    const {clock, limiter} = build();
    const call = limiter.run(() => 'full', {cost: 10});
    await settleAll(clock, [call]);

    await expect(call).resolves.toBe('full');
    expect(limiter.inspect().constraints[0]!.available).toBe(0);
  });

  it('refuses a cost one unit above burst, naming the constraint and the fix', () => {
    const {limiter} = build();
    expect(() => limiter.run(() => 'x', {cost: 11})).toThrow(/"per-second"/);
    expect(() => limiter.run(() => 'x', {cost: 11})).toThrow(/could never be admitted/);
    expect(() => limiter.run(() => 'x', {cost: 11})).toThrow(/Raise that constraint's burst/);
  });

  it('treats the declared burst as the real boundary, not burst plus epsilon', () => {
    // The bucket compares with a 1e-9 tolerance so a float a hair short of the
    // cost does not stall forever. That tolerance is an implementation detail
    // of the arithmetic, NOT an extension of the limit the caller declared —
    // so a cost above `burst` is refused even when it is within that tolerance.
    const {limiter} = build();
    expect(() => limiter.run(() => 'x', {cost: 10 + TOKEN_EPSILON})).toThrow(
      QuotaPilotConfigError
    );
    // The next representable double above 10.
    expect(() => limiter.run(() => 'x', {cost: 10 * (1 + Number.EPSILON)})).toThrow(
      QuotaPilotConfigError
    );
  });

  it('admits a cost that only LOOKS above burst in source', async () => {
    // `10 + Number.EPSILON` is exactly 10 as a double: the spacing between
    // representable values near 10 is about 1.8e-15, almost an order of
    // magnitude larger than EPSILON (2.2e-16), so the addition rounds away.
    // Pinned because it reads like a boundary violation and is not one.
    expect(10 + Number.EPSILON).toBe(10);

    const {clock, limiter} = build();
    const call = limiter.run(() => 'admitted', {cost: 10 + Number.EPSILON});
    await settleAll(clock, [call]);
    await expect(call).resolves.toBe('admitted');
  });

  it('checks against the SMALLEST burst across constraints', () => {
    const {limiter} = build([
      {name: 'wide', limit: 100, interval: 'second', burst: 100},
      {name: 'narrow', limit: 100, interval: 'second', burst: 4},
    ]);

    expect(() => limiter.run(() => 'x', {cost: 4})).not.toThrow();
    expect(() => limiter.run(() => 'x', {cost: 5})).toThrow(/"narrow"/);
  });

  it('names the first constraint that cannot take the cost', () => {
    // Deterministic reporting: declaration order, so the message does not
    // change depending on which constraint the loop happened to reach first.
    const {limiter} = build([
      {name: 'first-too-small', limit: 10, interval: 'second', burst: 2},
      {name: 'also-too-small', limit: 10, interval: 'second', burst: 1},
    ]);
    expect(() => limiter.run(() => 'x', {cost: 5})).toThrow(/"first-too-small"/);
  });
});

describe('cost — fractional values', () => {
  it('accepts a fraction and debits exactly that much', async () => {
    const {clock, limiter} = build();
    const call = limiter.run(() => 'x', {cost: 0.25});
    await settleAll(clock, [call]);

    expect(limiter.inspect().constraints[0]!.available).toBeCloseTo(9.75, 9);
  });

  it('accumulates fractions without drift that an operator would notice', async () => {
    const {clock, limiter} = build();
    const calls = Array.from({length: 10}, () => limiter.run(() => 'x', {key: 'k', cost: 0.1}));
    await settleAll(clock, calls);

    // Ten times 0.1 is not exactly 1 in binary floating point; the point is
    // that the error stays at the rounding level, not that it is zero.
    expect(limiter.inspect('k').constraints[0]!.available).toBeCloseTo(9, 9);
  });

  it('accepts the smallest representable positive cost', async () => {
    const {clock, limiter} = build();
    const call = limiter.run(() => 'tiny', {cost: Number.MIN_VALUE});
    await settleAll(clock, [call]);
    await expect(call).resolves.toBe('tiny');
  });

  it('paces fractional costs by the capacity they actually consume', async () => {
    const {clock, limiter} = build([{name: 'one', limit: 10, interval: 'second', burst: 1}]);
    const admittedAt: number[] = [];

    // Four half-unit calls on a 1-unit bucket refilling at 10/sec: two run at
    // once, then one every 50ms.
    const calls = Array.from({length: 4}, () =>
      limiter.run(() => void admittedAt.push(clock.now()), {key: 'k', cost: 0.5})
    );
    await settleAll(clock, calls);

    expect(admittedAt).toEqual([0, 0, 50, 100]);
  });
});

describe('cost — weighted under multiple constraints', () => {
  it('debits every constraint by the same cost', async () => {
    const {clock, limiter} = build([
      {name: 'a', limit: 20, interval: 'second'},
      {name: 'b', limit: 50, interval: 'second'},
    ]);
    const call = limiter.run(() => 'x', {key: 'k', cost: 3});
    await settleAll(clock, [call]);

    const snapshot = limiter.inspect('k');
    expect(snapshot.constraints[0]!.available).toBe(17);
    expect(snapshot.constraints[1]!.available).toBe(47);
  });

  it('waits for whichever constraint needs longest for THAT cost', async () => {
    const {clock, limiter} = build([
      {name: 'wide-slow', limit: 10, interval: 'second', burst: 10},
      {name: 'narrow-fast', limit: 100, interval: 'second', burst: 5},
    ]);
    const admittedAt: number[] = [];

    // Two cost-5 calls. The first empties 'narrow-fast' and takes half of
    // 'wide-slow'. The second needs 5 from each: 'narrow-fast' recovers in
    // 50ms, 'wide-slow' already has 5 — so 50ms.
    const calls = Array.from({length: 2}, () =>
      limiter.run(() => void admittedAt.push(clock.now()), {key: 'k', cost: 5})
    );
    await settleAll(clock, calls);

    expect(admittedAt).toEqual([0, 50]);
  });

  it('mixes costs on one key and still conserves every constraint', async () => {
    const {clock, limiter} = build([{name: 'only', limit: 10, interval: 'second', burst: 10}]);
    const admissions: {at: number; cost: number}[] = [];

    const costs = [4, 1, 3, 2, 5, 1];
    const calls = costs.map((cost) =>
      limiter.run(() => void admissions.push({at: clock.now(), cost}), {key: 'k', cost})
    );
    await settleAll(clock, calls);

    expect(admissions).toHaveLength(costs.length);
    // Conservation: over any window, consumed <= burst + rate * window.
    for (let i = 0; i < admissions.length; i++) {
      let total = 0;
      for (let j = i; j < admissions.length; j++) {
        total += admissions[j]!.cost;
        const windowMs = admissions[j]!.at - admissions[i]!.at;
        expect(total).toBeLessThanOrEqual(10 + 0.01 * windowMs + TOKEN_EPSILON * 8);
      }
    }
  });
});

describe('cost — invalid configuration is caught at construction', () => {
  it.each([
    ['zero limit', {name: 'x', limit: 0, interval: 'second'}],
    ['zero burst', {name: 'x', limit: 1, interval: 'second', burst: 0}],
    ['negative burst', {name: 'x', limit: 1, interval: 'second', burst: -1}],
    ['NaN burst', {name: 'x', limit: 1, interval: 'second', burst: Number.NaN}],
    ['infinite burst', {name: 'x', limit: 1, interval: 'second', burst: Infinity}],
  ])('rejects %s before any call is made', (_label, constraint) => {
    expect(() => createLimiter({constraints: [constraint as RateConstraint]})).toThrow(
      QuotaPilotConfigError
    );
  });

  it('a cost that can never be admitted fails deterministically, not by waiting', () => {
    // Repeated to make the point that the outcome does not depend on timing,
    // scheduler state, or how much capacity happens to be free.
    const {limiter} = build();
    for (let repeat = 0; repeat < 5; repeat++) {
      expect(() => limiter.run(() => 'x', {cost: 1_000})).toThrow(QuotaPilotConfigError);
    }
    expect(limiter.stats()).toEqual({keys: 0, queued: 0, inflight: 0, backingOff: 0, decisionHookErrors: 0});
  });
});
