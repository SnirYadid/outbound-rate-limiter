/**
 * Binding-constraint identification.
 *
 * "Which limit made us wait" is the question the audit that motivated this
 * library could not answer. These tests pin the answer and, just as
 * importantly, pin that it is DETERMINISTIC: the constraint with the longest
 * wait, ties going to declaration order.
 */

import {describe, expect, it} from 'vitest';

import {tryAdmit} from '../src/admit.js';
import {normalizeConstraints} from '../src/constraints.js';
import {createLimiter} from '../src/limiter.js';
import {createPartitionRegistry} from '../src/partition.js';
import {createSemaphore} from '../src/semaphore.js';
import {LimiterSaturatedError} from '../src/errors.js';
import type {RateConstraint} from '../src/types.js';
import {createVirtualClock} from './harness/virtual-clock.js';
import {settleAll} from './harness/settle.js';

/** Drives `tryAdmit` directly, so a refusal can be inspected without a queue. */
function bench(input: RateConstraint[], maxConcurrent = Infinity, maxConcurrentPerKey = Infinity) {
  const constraints = normalizeConstraints(input);
  const clock = createVirtualClock(0);
  const registry = createPartitionRegistry({
    constraints,
    maxKeys: 100,
    maxQueueDepth: 100,
    sweepIntervalMs: Infinity,
    clock,
  });
  const semaphore = createSemaphore(maxConcurrent);
  const context = {constraints, semaphore, maxConcurrentPerKey};
  const partition = registry.acquire('k');

  return {
    clock,
    partition,
    semaphore,
    admit: (cost = 1) => tryAdmit(partition, cost, clock.now(), context),
    /** Drains a named constraint to exactly `tokens`. */
    setTokens: (name: string, tokens: number) => {
      const index = constraints.findIndex((c) => c.name === name);
      partition.buckets[index] = {tokens, updatedAt: clock.now()};
    },
  };
}

describe('binding constraint — single blocker', () => {
  it('names the only constraint that is out of capacity', () => {
    const b = bench([
      {name: 'fast', limit: 100, interval: 'second'},
      {name: 'slow', limit: 10, interval: 'second'},
    ]);
    b.setTokens('slow', 0);

    const outcome = b.admit(1);

    expect(outcome.admitted).toBe(false);
    if (outcome.admitted) throw new Error('unreachable');
    expect(outcome.blockedBy).toBe('rate');
    if (outcome.blockedBy !== 'rate') throw new Error('unreachable');
    expect(outcome.binding).toBe('slow');
    expect(outcome.waitMs).toBe(100); // one token at 10/sec
  });

  it('names the constraint even when it is declared first', () => {
    const b = bench([
      {name: 'slow', limit: 10, interval: 'second'},
      {name: 'fast', limit: 100, interval: 'second'},
    ]);
    b.setTokens('slow', 0);

    const outcome = b.admit(1);
    if (outcome.admitted || outcome.blockedBy !== 'rate') throw new Error('unreachable');
    expect(outcome.binding).toBe('slow');
  });
});

describe('binding constraint — multiple blockers', () => {
  it('names the one with the LONGEST wait, not the first to fail', () => {
    // Both are out of capacity. 'sustained' refills far more slowly, so it is
    // the one actually being waited on — naming 'burst' would send an operator
    // to tune the wrong knob.
    const b = bench([
      {name: 'burst', limit: 100, interval: 'second'}, // 10ms per token
      {name: 'sustained', limit: 10, interval: 'second'}, // 100ms per token
    ]);
    b.setTokens('burst', 0);
    b.setTokens('sustained', 0);

    const outcome = b.admit(1);
    if (outcome.admitted || outcome.blockedBy !== 'rate') throw new Error('unreachable');

    expect(outcome.binding).toBe('sustained');
    expect(outcome.waitMs).toBe(100);
  });

  it('still names the slowest when the fast one is declared second', () => {
    const b = bench([
      {name: 'sustained', limit: 10, interval: 'second'},
      {name: 'burst', limit: 100, interval: 'second'},
    ]);
    b.setTokens('burst', 0);
    b.setTokens('sustained', 0);

    const outcome = b.admit(1);
    if (outcome.admitted || outcome.blockedBy !== 'rate') throw new Error('unreachable');
    expect(outcome.binding).toBe('sustained');
  });

  it('picks the longest of three', () => {
    const b = bench([
      {name: 'a', limit: 1_000, interval: 'second'},
      {name: 'b', limit: 10, interval: 'second'},
      {name: 'c', limit: 100, interval: 'second'},
    ]);
    for (const name of ['a', 'b', 'c']) b.setTokens(name, 0);

    const outcome = b.admit(1);
    if (outcome.admitted || outcome.blockedBy !== 'rate') throw new Error('unreachable');
    expect(outcome.binding).toBe('b');
  });

  it('ignores constraints that have capacity, however slow they are', () => {
    const b = bench([
      {name: 'glacial', limit: 1, interval: 'hour'},
      {name: 'quick', limit: 50, interval: 'second'},
    ]);
    // 'glacial' refills at an hour per token but still HAS its token.
    b.setTokens('quick', 0);

    const outcome = b.admit(1);
    if (outcome.admitted || outcome.blockedBy !== 'rate') throw new Error('unreachable');
    expect(outcome.binding).toBe('quick');
  });
});

describe('binding constraint — ties', () => {
  it('breaks a tie by declaration order, deterministically', () => {
    const b = bench([
      {name: 'first', limit: 10, interval: 'second'},
      {name: 'second', limit: 10, interval: 'second'},
    ]);
    b.setTokens('first', 0);
    b.setTokens('second', 0);

    // Identical rates, identical deficits, so identical waits.
    for (let repeat = 0; repeat < 5; repeat++) {
      const outcome = b.admit(1);
      if (outcome.admitted || outcome.blockedBy !== 'rate') throw new Error('unreachable');
      expect(outcome.binding).toBe('first');
    }
  });

  it('reverses with declaration order, proving the rule is order and not name', () => {
    const b = bench([
      {name: 'second', limit: 10, interval: 'second'},
      {name: 'first', limit: 10, interval: 'second'},
    ]);
    b.setTokens('first', 0);
    b.setTokens('second', 0);

    const outcome = b.admit(1);
    if (outcome.admitted || outcome.blockedBy !== 'rate') throw new Error('unreachable');
    expect(outcome.binding).toBe('second');
  });
});

describe('binding constraint — weighted costs', () => {
  it('can shift which constraint binds as the cost grows', () => {
    // 'wide' holds a lot but refills slowly; 'narrow' holds little but
    // refills fast. Which one binds depends on the cost asked for.
    const b = bench([
      {name: 'wide', limit: 10, interval: 'second', burst: 50},
      {name: 'narrow', limit: 100, interval: 'second', burst: 5},
    ]);
    b.setTokens('wide', 4);
    b.setTokens('narrow', 0);

    // cost 1: narrow needs 10ms, wide has plenty.
    const cheap = b.admit(1);
    if (cheap.admitted || cheap.blockedBy !== 'rate') throw new Error('unreachable');
    expect(cheap.binding).toBe('narrow');
    expect(cheap.waitMs).toBe(10);

    // cost 5: narrow needs 50ms, wide needs 100ms for its missing 1 unit.
    const dear = b.admit(5);
    if (dear.admitted || dear.blockedBy !== 'rate') throw new Error('unreachable');
    expect(dear.binding).toBe('wide');
    expect(dear.waitMs).toBe(100);
  });

  it('scales the reported wait with the cost', () => {
    const b = bench([{name: 'only', limit: 10, interval: 'second', burst: 10}]);
    b.setTokens('only', 0);

    const one = b.admit(1);
    const three = b.admit(3);
    if (one.admitted || one.blockedBy !== 'rate') throw new Error('unreachable');
    if (three.admitted || three.blockedBy !== 'rate') throw new Error('unreachable');

    expect(one.waitMs).toBe(100);
    expect(three.waitMs).toBe(300);
    expect(three.binding).toBe('only');
  });
});

describe('binding constraint — refusal takes nothing (S5)', () => {
  it('leaves every bucket untouched in capacity terms when it refuses', () => {
    const b = bench([
      {name: 'has-plenty', limit: 100, interval: 'second'},
      {name: 'empty', limit: 10, interval: 'second'},
    ]);
    b.setTokens('has-plenty', 100);
    b.setTokens('empty', 0);

    const before = b.partition.buckets.map((bucket) => bucket.tokens);
    const outcome = b.admit(1);

    expect(outcome.admitted).toBe(false);
    expect(b.partition.buckets.map((bucket) => bucket.tokens)).toEqual(before);
  });

  it('does not take a concurrency slot when rate refuses', () => {
    const b = bench([{name: 'empty', limit: 10, interval: 'second'}], 4);
    b.setTokens('empty', 0);

    b.admit(1);

    // Rate is checked before the slot precisely so a rate-blocked key cannot
    // sit on concurrency it is unable to use.
    expect(b.semaphore.inFlight).toBe(0);
  });

  it('does not consume capacity when the concurrency cap refuses', () => {
    const b = bench([{name: 'plenty', limit: 100, interval: 'second'}], 1);
    const first = b.admit(1);
    expect(first.admitted).toBe(true);

    const tokensAfterFirst = b.partition.buckets[0]!.tokens;
    const second = b.admit(1);

    expect(second.admitted).toBe(false);
    if (second.admitted) throw new Error('unreachable');
    expect(second.blockedBy).toBe('slot');
    expect(b.partition.buckets[0]!.tokens).toBe(tokensAfterFirst);
  });
});

describe('binding constraint — reaches the public error', () => {
  it('names the binding constraint in a rejected call', async () => {
    const clock = createVirtualClock(0);
    const limiter = createLimiter({
      constraints: [
        {name: 'per-second', limit: 100, interval: 'second'},
        {name: 'per-minute', limit: 2, interval: 'minute', burst: 2},
      ],
      clock,
    });

    // Spend the per-minute allowance; it is the slower of the two to recover.
    const warmup = [
      limiter.run(() => 'a', {key: 'k'}),
      limiter.run(() => 'b', {key: 'k'}),
    ];
    await settleAll(clock, warmup);

    const refused = limiter.run(() => 'c', {key: 'k', onSaturated: 'reject'});
    await expect(refused).rejects.toThrow(LimiterSaturatedError);
    await refused.catch((error: unknown) => {
      const saturated = error as LimiterSaturatedError;
      expect(saturated.kind).toBe('rate');
      expect(saturated.binding).toBe('per-minute');
      expect(saturated.waitMs).toBeGreaterThan(0);
      expect(saturated.key).toBe('k');
      // The message should be readable without reading the fields.
      expect(saturated.message).toMatch(/"per-minute"/);
      expect(saturated.message).toMatch(/capacity returns in/);
    });
  });
});
