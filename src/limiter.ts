/**
 * `createLimiter` — the wiring, and the only module that knows about all the
 * others.
 *
 * Day 2 scope: constraints, keyed partitioning with safe eviction, global and
 * per-key concurrency, bounded per-key FIFO queues. No retries, no per-attempt
 * timeouts, no cancellation, no telemetry events — those arrive in later
 * milestones and are additive to this surface.
 */

import {
  assertCostAdmissible,
  constraintWarnings,
  normalizeConstraints,
} from './constraints.js';
import {QuotaPilotConfigError, QuotaPilotQueueFullError} from './errors.js';
import {createPartitionRegistry, type QueuedCall} from './partition.js';
import {pump, type SchedulerContext} from './scheduler.js';
import {createSemaphore} from './semaphore.js';
import {realClock} from './time.js';
import type {Limiter, LimiterOptions, LimiterStats, RunOptions} from './types.js';

/** Per-key queue bound. Deliberately finite: see queue.ts. */
export const DEFAULT_MAX_QUEUE_DEPTH = 1_024;
/** Tracked-key ceiling. Generous — state per key is a few numbers. */
export const DEFAULT_MAX_KEYS = 10_000;

export function createLimiter(options: LimiterOptions): Limiter {
  if (typeof options !== 'object' || options === null) {
    throw new QuotaPilotConfigError('createLimiter requires an options object.');
  }

  const constraints = normalizeConstraints(options.constraints);
  const warnings = Object.freeze(constraintWarnings(constraints));

  const maxConcurrent = countOption(options.maxConcurrent, Infinity, 'maxConcurrent');
  const maxConcurrentPerKey = countOption(
    options.maxConcurrentPerKey,
    Infinity,
    'maxConcurrentPerKey'
  );
  const maxQueueDepth = countOption(
    options.maxQueueDepth,
    DEFAULT_MAX_QUEUE_DEPTH,
    'maxQueueDepth'
  );
  const maxKeys = countOption(options.maxKeys, DEFAULT_MAX_KEYS, 'maxKeys');
  const clock = options.clock ?? realClock;

  // Default: the longest time any constraint needs to refill from empty. That
  // is the soonest a drained partition could become disposable, so sweeping
  // more often than this cannot find anything the previous sweep missed.
  const defaultSweepIntervalMs = constraints.reduce(
    (longest, constraint) => Math.max(longest, constraint.spec.capacity / constraint.spec.ratePerMs),
    0
  );
  const sweepIntervalMs = sweepOption(options.sweepIntervalMs, defaultSweepIntervalMs);

  const semaphore = createSemaphore(maxConcurrent);
  const registry = createPartitionRegistry({
    constraints,
    maxKeys,
    maxQueueDepth,
    sweepIntervalMs,
    clock,
  });

  const context: SchedulerContext = {constraints, semaphore, maxConcurrentPerKey, clock};

  return {
    run<T>(fn: (ctx: {key: string; elapsedMs: number}) => T | Promise<T>, runOptions?: RunOptions) {
      if (typeof fn !== 'function') {
        throw new QuotaPilotConfigError('run() requires a function to execute.');
      }
      const key = runOptions?.key ?? '';
      if (typeof key !== 'string') {
        throw new QuotaPilotConfigError(
          `run() key must be a string, received ${JSON.stringify(key)}.`
        );
      }
      const cost = runOptions?.cost ?? 1;
      // Synchronous on purpose: a cost no constraint could ever admit is a
      // programming error, and it should fail where it was written rather than
      // becoming a promise that never settles.
      assertCostAdmissible(cost, constraints);

      return new Promise<T>((resolve, reject) => {
        // `acquire` throws when the registry is full and nothing is safe to
        // evict. Converted to a rejection because by this point the caller
        // holds a promise, and a mix of sync throws and rejections from one
        // call site is worse than either alone.
        let partition;
        try {
          partition = registry.acquire(key);
        } catch (error) {
          reject(error);
          return;
        }

        const enqueuedAt = clock.now();

        const call: QueuedCall = {
          cost,
          enqueuedAt,
          start: (release) => {
            let settled = false;
            // One exit path for every outcome, so the slot is released exactly
            // once and the in-flight count cannot drift.
            const finish = (): void => {
              // Unreachable today — `finish` has exactly one caller per
              // outcome, and a promise settles once. Kept because Day 5 adds a
              // second path (an abort firing while the task is still in
              // flight), and a double release would inflate concurrency.
              /* c8 ignore next */
              if (settled) return;
              settled = true;
              partition.inflight--;
              // Per-key capacity first, then the global slot: releasing the
              // slot can synchronously hand it to another key's pump, and that
              // pump should see this key's count already decremented.
              release();
              pump(partition, context);
            };

            let result: T | Promise<T>;
            try {
              result = fn({key, elapsedMs: clock.now() - enqueuedAt});
            } catch (error) {
              // A synchronous throw still consumed capacity and a slot. Both
              // are accounted for here; capacity is never refunded.
              finish();
              reject(error);
              return;
            }

            Promise.resolve(result).then(
              (value) => {
                finish();
                resolve(value);
              },
              (error: unknown) => {
                finish();
                reject(error);
              }
            );
          },
        };

        if (!partition.queue.enqueue(call)) {
          reject(
            new QuotaPilotQueueFullError(
              `Queue for key ${JSON.stringify(key)} is full (${maxQueueDepth} waiting). ` +
                'Raise maxQueueDepth, slow the producer, or reject earlier — an unbounded ' +
                'queue would trade this error for unbounded memory.',
              {key}
            )
          );
          return;
        }

        pump(partition, context);
      });
    },

    stats: (): LimiterStats => ({
      keys: registry.size,
      queued: registry.totalQueued(),
      inflight: registry.totalInflight(),
    }),

    warnings,
  };
}

/** A positive integer, or `Infinity` to mean "no limit". */
function countOption(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    throw new QuotaPilotConfigError(
      `${label} must be a positive integer or Infinity, received ${JSON.stringify(value)}.`
    );
  }
  if (value !== Infinity && !Number.isInteger(value)) {
    throw new QuotaPilotConfigError(
      `${label} must be a whole number, received ${JSON.stringify(value)}.`
    );
  }
  return value;
}

/** Zero (sweep always) through `Infinity` (never sweep on a schedule). */
function sweepOption(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    throw new QuotaPilotConfigError(
      `sweepIntervalMs must be zero or greater, received ${JSON.stringify(value)}.`
    );
  }
  return value;
}
