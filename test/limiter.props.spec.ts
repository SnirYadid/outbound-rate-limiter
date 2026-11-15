/**
 * Property tests for the limiter as a whole.
 *
 * Day 1 proved the bucket conserves capacity. These prove the property
 * survives the queue, the semaphore, keyed partitioning and eviction — i.e.
 * that no layer above the bucket hands out capacity the bucket never issued.
 */

import fc from 'fast-check';
import {describe, expect, it} from 'vitest';

import {normalizeConstraints} from '../src/constraints.js';
import {createLimiter} from '../src/limiter.js';
import {TOKEN_EPSILON} from '../src/bucket.js';
import {createSeededRandom} from '../src/random.js';
import type {RateConstraint} from '../src/types.js';
import {settleAll} from './harness/settle.js';
import {createVirtualClock} from './harness/virtual-clock.js';

interface Arrival {
  readonly gapMs: number;
  readonly keyIndex: number;
  readonly cost: number;
  readonly fails: boolean;
}

const arbArrivals = fc.array(
  fc.record({
    gapMs: fc.integer({min: 0, max: 400}),
    keyIndex: fc.integer({min: 0, max: 4}),
    cost: fc.integer({min: 1, max: 3}),
    fails: fc.boolean(),
  }),
  {minLength: 1, maxLength: 40}
);

const arbShape = fc.record({
  maxConcurrent: fc.oneof(fc.constant(Infinity), fc.integer({min: 1, max: 4})),
  maxConcurrentPerKey: fc.oneof(fc.constant(Infinity), fc.integer({min: 1, max: 3})),
  sweepIntervalMs: fc.oneof(fc.constant(0), fc.constant(Infinity), fc.integer({min: 1, max: 500})),
});

interface RunRecord {
  readonly key: string;
  readonly at: number;
  readonly cost: number;
}

interface Observation {
  readonly admissions: RunRecord[];
  readonly peakGlobal: number;
  readonly peakPerKey: Map<string, number>;
  readonly settled: number;
  readonly finalQueued: number;
  readonly finalInflight: number;
  readonly pendingTimers: number;
}

async function observe(
  constraints: RateConstraint[],
  arrivals: readonly Arrival[],
  shape: {maxConcurrent: number; maxConcurrentPerKey: number; sweepIntervalMs: number}
): Promise<Observation> {
  const clock = createVirtualClock(0);
  const limiter = createLimiter({constraints, clock, ...shape});

  const admissions: RunRecord[] = [];
  const liveByKey = new Map<string, number>();
  const peakPerKey = new Map<string, number>();
  let live = 0;
  let peakGlobal = 0;
  let settled = 0;
  const pending: Promise<unknown>[] = [];

  for (const arrival of arrivals) {
    if (arrival.gapMs > 0) await clock.advance(arrival.gapMs);
    const key = `key-${arrival.keyIndex}`;

    const call = limiter
      .run(
        async () => {
          admissions.push({key, at: clock.now(), cost: arrival.cost});
          live++;
          peakGlobal = Math.max(peakGlobal, live);
          const perKey = (liveByKey.get(key) ?? 0) + 1;
          liveByKey.set(key, perKey);
          peakPerKey.set(key, Math.max(peakPerKey.get(key) ?? 0, perKey));

          try {
            if (arrival.fails) throw new Error('synthetic');
            return 'ok';
          } finally {
            live--;
            liveByKey.set(key, (liveByKey.get(key) ?? 1) - 1);
          }
        },
        {key, cost: arrival.cost}
      )
      .then(
        () => {
          settled++;
        },
        () => {
          settled++;
        }
      );
    pending.push(call);
  }

  await settleAll(clock, pending);

  const stats = limiter.stats();
  return {
    admissions,
    peakGlobal,
    peakPerKey,
    settled,
    finalQueued: stats.queued,
    finalInflight: stats.inflight,
    pendingTimers: clock.pendingTimers(),
  };
}

describe('limiter properties', () => {
  const constraints: RateConstraint[] = [
    {name: 'burst', limit: 4, interval: 'second', burst: 4},
    {name: 'sustained', limit: 30, interval: 'minute', burst: 4},
  ];
  const normalized = normalizeConstraints(constraints);

  it('P-A CONSERVATION: per key and per constraint, admitted cost <= burst + rate * window', async () => {
    // The guarantee the whole library exists to provide, observed end to end
    // rather than at the bucket.
    await fc.assert(
      fc.asyncProperty(arbArrivals, arbShape, async (arrivals, shape) => {
        const {admissions} = await observe(constraints, arrivals, shape);

        for (const constraint of normalized) {
          const byKey = new Map<string, RunRecord[]>();
          for (const record of admissions) {
            const list = byKey.get(record.key) ?? [];
            list.push(record);
            byKey.set(record.key, list);
          }

          for (const records of byKey.values()) {
            for (let i = 0; i < records.length; i++) {
              let total = 0;
              for (let j = i; j < records.length; j++) {
                total += records[j]!.cost;
                const windowMs = records[j]!.at - records[i]!.at;
                const bound =
                  constraint.spec.capacity + constraint.spec.ratePerMs * windowMs;
                expect(total).toBeLessThanOrEqual(bound + TOKEN_EPSILON * (j - i + 2));
              }
            }
          }
        }
      }),
      {numRuns: 60}
    );
  });

  it('P-B CAPS: in-flight never exceeds the global or the per-key cap', async () => {
    await fc.assert(
      fc.asyncProperty(arbArrivals, arbShape, async (arrivals, shape) => {
        const {peakGlobal, peakPerKey} = await observe(constraints, arrivals, shape);

        expect(peakGlobal).toBeLessThanOrEqual(shape.maxConcurrent);
        for (const peak of peakPerKey.values()) {
          expect(peak).toBeLessThanOrEqual(shape.maxConcurrentPerKey);
        }
      }),
      {numRuns: 60}
    );
  });

  it('P-C LIVENESS: every call settles, queues drain, nothing is left pending', async () => {
    // Mandatory, and never a scope cut: the difference between a limiter and
    // a hang is exactly this property.
    await fc.assert(
      fc.asyncProperty(arbArrivals, arbShape, async (arrivals, shape) => {
        const {settled, finalQueued, finalInflight, pendingTimers} = await observe(
          constraints,
          arrivals,
          shape
        );

        expect(settled).toBe(arrivals.length);
        expect(finalQueued).toBe(0);
        expect(finalInflight).toBe(0);
        expect(pendingTimers).toBe(0);
      }),
      {numRuns: 60}
    );
  });

  it('P-D ISOLATION: a key never consumes another key’s capacity', async () => {
    // Stated as: each key's admissions alone satisfy the bound. If capacity
    // leaked between partitions, a quiet key would be able to exceed it.
    await fc.assert(
      fc.asyncProperty(arbArrivals, async (arrivals) => {
        const {admissions} = await observe(constraints, arrivals, {
          maxConcurrent: Infinity,
          maxConcurrentPerKey: Infinity,
          sweepIntervalMs: 0,
        });

        const constraint = normalized[0]!;
        const byKey = new Map<string, number>();
        for (const record of admissions) {
          // Within the first 1 ms nothing has refilled, so the total admitted
          // per key cannot exceed that key's own burst.
          if (record.at === 0) {
            byKey.set(record.key, (byKey.get(record.key) ?? 0) + record.cost);
          }
        }
        for (const total of byKey.values()) {
          expect(total).toBeLessThanOrEqual(constraint.spec.capacity + TOKEN_EPSILON);
        }
      }),
      {numRuns: 60}
    );
  });
});

describe('limiter properties — with retries', () => {
  const constraints: RateConstraint[] = [
    {name: 'burst', limit: 6, interval: 'second', burst: 4},
    {name: 'sustained', limit: 40, interval: 'minute', burst: 4},
  ];
  const normalized = normalizeConstraints(constraints);

  interface RetryArrival {
    readonly gapMs: number;
    readonly keyIndex: number;
    readonly cost: number;
    readonly failuresBeforeSuccess: number;
  }

  const arbRetryArrivals = fc.array(
    fc.record({
      gapMs: fc.integer({min: 0, max: 300}),
      keyIndex: fc.integer({min: 0, max: 3}),
      cost: fc.integer({min: 1, max: 2}),
      failuresBeforeSuccess: fc.integer({min: 0, max: 3}),
    }),
    {minLength: 1, maxLength: 25}
  );

  const arbRetryShape = fc.record({
    maxConcurrent: fc.oneof(fc.constant(Infinity), fc.integer({min: 1, max: 3})),
    // 0 sweeps on every new key, which is what makes the eviction hazard most
    // likely to show up if the backingOff counter were ever wrong.
    sweepIntervalMs: fc.oneof(fc.constant(0), fc.constant(Infinity)),
    seed: fc.integer({min: 1, max: 10_000}),
  });

  async function observeRetries(
    arrivals: readonly RetryArrival[],
    shape: {maxConcurrent: number; sweepIntervalMs: number; seed: number}
  ): Promise<{admissions: RunRecord[]; settled: number; stats: ReturnType<typeof createLimiter>['stats'] extends () => infer S ? S : never}> {
    const clock = createVirtualClock(0);
    const limiter = createLimiter({
      constraints,
      clock,
      maxConcurrent: shape.maxConcurrent,
      sweepIntervalMs: shape.sweepIntervalMs,
      maxKeys: 50,
      random: createSeededRandom(shape.seed),
    });

    const admissions: RunRecord[] = [];
    let settled = 0;
    const pending: Promise<unknown>[] = [];

    for (const arrival of arrivals) {
      if (arrival.gapMs > 0) await clock.advance(arrival.gapMs);
      const key = `key-${arrival.keyIndex}`;

      pending.push(
        limiter
          .run(
            (ctx) => {
              // Every ATTEMPT is recorded, because every attempt spends
              // capacity — that is the property under test.
              admissions.push({key, at: clock.now(), cost: arrival.cost});
              if (ctx.attempt <= arrival.failuresBeforeSuccess) throw new Error('flaky');
              return 'ok';
            },
            {
              key,
              cost: arrival.cost,
              retry: {
                maxAttempts: 4,
                baseDelayMs: 20,
                maxDelayMs: 200,
                classify: () => ({retry: true}),
              },
            }
          )
          .then(
            () => {
              settled++;
            },
            () => {
              settled++;
            }
          )
      );
    }

    await settleAll(clock, pending);
    return {admissions, settled, stats: limiter.stats() as never};
  }

  it('P-E CONSERVATION SURVIVES RETRIES: every attempt is charged, and the bound still holds', async () => {
    // The strongest guard against the quota-duplication hazard. If a
    // backing-off call ever lost its partition and re-entered a fresh one,
    // some window here would exceed `burst + rate * window`.
    await fc.assert(
      fc.asyncProperty(arbRetryArrivals, arbRetryShape, async (arrivals, shape) => {
        const {admissions} = await observeRetries(arrivals, shape);

        for (const constraint of normalized) {
          const byKey = new Map<string, RunRecord[]>();
          for (const record of admissions) {
            const list = byKey.get(record.key) ?? [];
            list.push(record);
            byKey.set(record.key, list);
          }

          for (const records of byKey.values()) {
            for (let i = 0; i < records.length; i++) {
              let total = 0;
              for (let j = i; j < records.length; j++) {
                total += records[j]!.cost;
                const windowMs = records[j]!.at - records[i]!.at;
                const bound = constraint.spec.capacity + constraint.spec.ratePerMs * windowMs;
                expect(total).toBeLessThanOrEqual(bound + TOKEN_EPSILON * (j - i + 2));
              }
            }
          }
        }
      }),
      {numRuns: 40}
    );
  });

  it('P-F LIVENESS SURVIVES RETRIES: every call settles and nothing is left sleeping', async () => {
    await fc.assert(
      fc.asyncProperty(arbRetryArrivals, arbRetryShape, async (arrivals, shape) => {
        const {settled, stats} = await observeRetries(arrivals, shape);

        expect(settled).toBe(arrivals.length);
        expect(stats).toMatchObject({queued: 0, inflight: 0, backingOff: 0});
      }),
      {numRuns: 40}
    );
  });
});
