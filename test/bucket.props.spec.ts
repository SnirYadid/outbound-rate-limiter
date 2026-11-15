/**
 * Property tests for the bucket invariants.
 *
 * These run on Day 1 on purpose. The conservation property is the single test
 * most likely to invalidate the design, and a design error found late in the
 * week cannot be fixed inside the week.
 */

import fc from 'fast-check';
import {describe, expect, it} from 'vitest';

import {
  type BucketSpec,
  type BucketState,
  commit,
  createBucket,
  peek,
  TOKEN_EPSILON,
} from '../src/bucket.js';

/** A plausible constraint: limits 1..500 over 100 ms..1 h, burst >= 1. */
const arbSpec = fc
  .record({
    limit: fc.integer({min: 1, max: 500}),
    intervalMs: fc.integer({min: 100, max: 3_600_000}),
    burstFactor: fc.double({min: 1, max: 20, noNaN: true, noDefaultInfinity: true}),
  })
  .map(({limit, intervalMs, burstFactor}) => {
    const capacity = Math.max(1, Math.round(limit * burstFactor) / burstFactor);
    const spec: BucketSpec = {capacity, ratePerMs: limit / intervalMs};
    return spec;
  });

/** A run of (time step, cost) arrivals. */
const arbArrivals = fc.array(
  fc.record({
    stepMs: fc.integer({min: 0, max: 5_000}),
    costFactor: fc.double({min: 0.01, max: 1, noNaN: true, noDefaultInfinity: true}),
  }),
  {minLength: 1, maxLength: 150}
);

interface Admission {
  readonly at: number;
  readonly cost: number;
}

/**
 * Replays arrivals against a bucket, taking whatever is admissible, and
 * returns both the admissions and the states observed along the way.
 */
function simulate(
  spec: BucketSpec,
  arrivals: readonly {stepMs: number; costFactor: number}[]
): {admissions: Admission[]; states: BucketState[]} {
  let now = 0;
  let state = createBucket(now, spec);
  const admissions: Admission[] = [];
  const states: BucketState[] = [state];

  for (const arrival of arrivals) {
    now += arrival.stepMs;
    // Keep every cost admissible so the run exercises admission, not refusal
    // of impossible work (that case has its own unit test).
    const cost = Math.max(TOKEN_EPSILON, spec.capacity * arrival.costFactor);
    const result = peek(state, now, cost, spec);
    if (result.ok) {
      state = commit(result.refilled, cost, spec);
      admissions.push({at: now, cost});
    } else {
      state = result.refilled;
    }
    states.push(state);
  }

  return {admissions, states};
}

describe('bucket invariants', () => {
  it('B1: tokens stay within [0, capacity] through any sequence of operations', () => {
    fc.assert(
      fc.property(arbSpec, arbArrivals, (spec, arrivals) => {
        const {states} = simulate(spec, arrivals);
        for (const state of states) {
          expect(Number.isFinite(state.tokens)).toBe(true);
          expect(state.tokens).toBeGreaterThanOrEqual(0);
          expect(state.tokens).toBeLessThanOrEqual(spec.capacity);
        }
      }),
      {numRuns: 300}
    );
  });

  it('B2: updatedAt never moves backwards', () => {
    fc.assert(
      fc.property(arbSpec, arbArrivals, (spec, arrivals) => {
        const {states} = simulate(spec, arrivals);
        for (let i = 1; i < states.length; i++) {
          expect(states[i]!.updatedAt).toBeGreaterThanOrEqual(states[i - 1]!.updatedAt);
        }
      }),
      {numRuns: 300}
    );
  });

  it('G2 CONSERVATION: over every window, admitted cost <= capacity + rate * window', () => {
    // The headline guarantee. Checked over every contiguous window of the
    // admission sequence, which is the strongest form of the claim that can be
    // observed from outside.
    fc.assert(
      fc.property(arbSpec, arbArrivals, (spec, arrivals) => {
        const {admissions} = simulate(spec, arrivals);

        for (let i = 0; i < admissions.length; i++) {
          let total = 0;
          for (let j = i; j < admissions.length; j++) {
            total += admissions[j]!.cost;
            const windowMs = admissions[j]!.at - admissions[i]!.at;
            const bound = spec.capacity + spec.ratePerMs * windowMs;
            // Tolerance covers the documented EPSILON-early admission, scaled
            // by the number of admissions inside the window.
            const slack = TOKEN_EPSILON * (j - i + 2);
            expect(total).toBeLessThanOrEqual(bound + slack);
          }
        }
      }),
      {numRuns: 300}
    );
  });

  it('G3: long-run throughput does not exceed the configured rate', () => {
    fc.assert(
      fc.property(arbSpec, (spec) => {
        // Hammer the bucket with unit-ish demand far longer than one interval.
        const horizonMs = 600_000;
        const stepMs = Math.max(1, Math.floor(1 / spec.ratePerMs / 4));
        const cost = Math.min(spec.capacity, 1);

        let state = createBucket(0, spec);
        let admitted = 0;
        for (let now = 0; now <= horizonMs; now += stepMs) {
          const result = peek(state, now, cost, spec);
          if (result.ok) {
            state = commit(result.refilled, cost, spec);
            admitted += cost;
          } else {
            state = result.refilled;
          }
        }

        expect(admitted).toBeLessThanOrEqual(
          spec.capacity + spec.ratePerMs * horizonMs + TOKEN_EPSILON * 1_000
        );
      }),
      {numRuns: 200}
    );
  });

  it('B4: the reported wait never grows as time advances', () => {
    fc.assert(
      fc.property(
        arbSpec,
        fc.double({min: 0, max: 1, noNaN: true, noDefaultInfinity: true}),
        fc.array(fc.integer({min: 0, max: 10_000}), {minLength: 2, maxLength: 20}),
        (spec, costFactor, steps) => {
          const cost = Math.max(TOKEN_EPSILON, spec.capacity * costFactor);
          const drained: BucketState = {tokens: 0, updatedAt: 0};

          let now = 0;
          let previous = peek(drained, now, cost, spec).waitMs;
          for (const step of steps) {
            now += step;
            const current = peek(drained, now, cost, spec).waitMs;
            expect(current).toBeLessThanOrEqual(previous);
            previous = current;
          }
        }
      ),
      {numRuns: 300}
    );
  });

  it('G6: a cost above capacity is always reported unsatisfiable, never as a wait', () => {
    fc.assert(
      fc.property(
        arbSpec,
        fc.double({min: 1.0001, max: 100, noNaN: true, noDefaultInfinity: true}),
        fc.integer({min: 0, max: 10_000_000}),
        (spec, overshoot, now) => {
          const result = peek(createBucket(0, spec), now, spec.capacity * overshoot, spec);
          expect(result.unsatisfiable).toBe(true);
          expect(result.ok).toBe(false);
        }
      ),
      {numRuns: 200}
    );
  });

  it('G7: nothing ever restores tokens except elapsed time', () => {
    // There is no refund path. Asserted structurally: the module exports no
    // function that increases tokens without advancing the clock.
    fc.assert(
      fc.property(arbSpec, arbArrivals, (spec, arrivals) => {
        const {states} = simulate(spec, arrivals);
        for (let i = 1; i < states.length; i++) {
          const before = states[i - 1]!;
          const after = states[i]!;
          const elapsed = Math.max(0, after.updatedAt - before.updatedAt);
          const maxGrowth = elapsed * spec.ratePerMs + TOKEN_EPSILON;
          expect(after.tokens - before.tokens).toBeLessThanOrEqual(maxGrowth);
        }
      }),
      {numRuns: 300}
    );
  });
});
