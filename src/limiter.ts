/**
 * `createLimiter` — the wiring, and the only module that knows about all the
 * others.
 *
 * Scope so far: constraints, keyed partitioning with safe eviction, global and
 * per-key concurrency, bounded per-key FIFO queues, the `onSaturated` policy
 * and read-only inspection. No retries, no per-attempt timeouts, no
 * cancellation, no telemetry events — those arrive in later milestones and are
 * additive to this surface.
 */

import {tryAdmit, type AdmitOutcome} from './admit.js';
import {
  assertCostAdmissible,
  constraintWarnings,
  normalizeConstraints,
} from './constraints.js';
import {
  QuotaPilotAbortError,
  QuotaPilotConfigError,
  QuotaPilotQueueFullError,
  QuotaPilotSaturatedError,
} from './errors.js';
import {createCall} from './call.js';
import {createEmitter, sealEvent} from './telemetry.js';
import {inspectKey, type InspectContext} from './inspect.js';
import {createPartitionRegistry, type Partition, type QueuedCall} from './partition.js';
import {defaultRandom} from './random.js';
import {normalizeRetryPolicy} from './retry.js';
import {cancelWake, pump, type SchedulerContext} from './scheduler.js';
import {createSemaphore} from './semaphore.js';
import {realClock} from './time.js';
import type {
  AttemptContext,
  Decision,
  KeySnapshot,
  Limiter,
  LimiterOptions,
  LimiterStats,
  RefusalReason,
  RunOptions,
} from './types.js';

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
  const random = options.random ?? defaultRandom;

  // Default: the longest time any constraint needs to refill from empty. That
  // is the soonest a drained partition could become disposable, so sweeping
  // more often than this cannot find anything the previous sweep missed.
  const defaultSweepIntervalMs = constraints.reduce(
    (longest, constraint) => Math.max(longest, constraint.spec.capacity / constraint.spec.ratePerMs),
    0
  );
  const sweepIntervalMs = sweepOption(options.sweepIntervalMs, defaultSweepIntervalMs);

  const emitter = createEmitter(options.onDecision);

  /**
   * Every call that has not settled. `drain()` snapshots this, which is what
   * makes "calls accepted before the drain" an exact set rather than a guess.
   */
  const live = new Set<Promise<void>>();

  const semaphore = createSemaphore(maxConcurrent);
  const registry = createPartitionRegistry({
    constraints,
    maxKeys,
    maxQueueDepth,
    sweepIntervalMs,
    clock,
  });

  const context: SchedulerContext = {
    constraints,
    semaphore,
    maxConcurrentPerKey,
    clock,
    emit: (event) => {
      emitter.emit(event);
    },
    telemetry: emitter.active,
  };
  const inspectContext: InspectContext = {constraints, registry, clock};

  /** Reports a refusal the limiter raised before the call became live. */
  const publishRefusal = (key: string, reason: RefusalReason): void => {
    if (!emitter.active) return;
    const event: Decision = {
      at: clock.now(),
      key,
      scope: 'process',
      kind: 'refused',
      reason,
      attempts: 0,
      elapsedMs: 0,
    };
    emitter.emit(sealEvent(event));
  };

  /** Turns a refusal into the error the caller sees, with a usable message. */
  const saturated = (
    outcome: Extract<AdmitOutcome, {admitted: false}>,
    key: string
  ): QuotaPilotSaturatedError => {
    const forKey = `for key ${JSON.stringify(key)}`;
    if (outcome.blockedBy === 'rate') {
      return new QuotaPilotSaturatedError(
        `Rate constraint ${JSON.stringify(outcome.binding)} is saturated ${forKey}; ` +
          `capacity returns in ${outcome.waitMs}ms.`,
        {kind: 'rate', waitMs: outcome.waitMs, binding: outcome.binding, key}
      );
    }
    if (outcome.blockedBy === 'slot') {
      return new QuotaPilotSaturatedError(
        `The limiter-wide concurrency cap (maxConcurrent = ${maxConcurrent}) is full ${forKey}.`,
        {kind: 'concurrency', waitMs: 0, binding: 'maxConcurrent', key}
      );
    }
    return new QuotaPilotSaturatedError(
      `This key's concurrency cap (maxConcurrentPerKey = ${maxConcurrentPerKey}) is full ` +
        `${forKey}.`,
      {kind: 'key-concurrency', waitMs: 0, binding: 'maxConcurrentPerKey', key}
    );
  };

  return {
    run<T>(fn: (ctx: AttemptContext) => T | Promise<T>, runOptions?: RunOptions) {
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

      const signal = runOptions?.signal;
      if (signal !== undefined && typeof signal.addEventListener !== 'function') {
        throw new QuotaPilotConfigError(
          'run() signal must be an AbortSignal, or omitted.'
        );
      }

      const onSaturated = runOptions?.onSaturated ?? 'wait';
      if (onSaturated !== 'wait' && onSaturated !== 'reject') {
        throw new QuotaPilotConfigError(
          `run() onSaturated must be 'wait' or 'reject', received ` +
            `${JSON.stringify(onSaturated)}.`
        );
      }

      // Validated BEFORE the promise exists, so a configuration mistake throws
      // at the call site like every other one. Inside the executor it would
      // become a rejection, and a library that mixes the two for the same
      // class of mistake is one you cannot reason about.
      const retry =
        runOptions?.retry === undefined ? undefined : normalizeRetryPolicy(runOptions.retry);
      const attemptTimeoutMs = optionalMs(runOptions?.attemptTimeoutMs, 'attemptTimeoutMs');
      const totalBudgetMs = optionalMs(runOptions?.totalBudgetMs, 'totalBudgetMs');

      return new Promise<T>((resolve, reject) => {
        // An already-aborted signal is answered before the registry is
        // touched: no partition is created, no capacity is spent, and the
        // cancellation cannot be confused with a limiter refusal.
        if (signal?.aborted === true) {
          publishRefusal(key, 'aborted');
          // The signal's own `reason` is rethrown verbatim so this
          // interoperates with fetch. A caller may abort with any value, and
          // substituting our own would discard what they said.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(
            signal.reason ??
              new QuotaPilotAbortError('The call was aborted before it was submitted.', {key})
          );
          return;
        }

        // `acquire` throws when the registry is full and nothing is safe to
        // evict. Converted to a rejection because by this point the caller
        // holds a promise, and a mix of sync throws and rejections from one
        // call site is worse than either alone.
        let partition;
        try {
          partition = registry.acquire(key);
        } catch (error) {
          publishRefusal(key, 'key-limit');
          // A caught value is rethrown as-is; narrowing it would discard the
          // real cause.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error);
          return;
        }

        const {call, armDeadline, markQueued, refuse, done} = createCall<T>(
          {
            key,
            cost,
            fn,
            retry,
            attemptTimeoutMs,
            totalBudgetMs,
            signal,
            resolve,
            reject,
          },
          {
            clock,
            random,
            partition,
            repump: () => {
              pump(partition, context);
            },
            cancelWake: () => {
              cancelWake(partition);
            },
            emit: (event) => {
              emitter.emit(event);
            },
            telemetry: emitter.active,
          }
        );

        // Tracked for `drain()` and removed on settle, whatever the outcome.
        live.add(done);
        void done.then(() => {
          live.delete(done);
        });

        if (onSaturated === 'reject') {
          rejectOrStart(partition, call, key, refuse);
          return;
        }

        if (!partition.queue.enqueue(call)) {
          refuse(
            new QuotaPilotQueueFullError(
              `Queue for key ${JSON.stringify(key)} is full (${maxQueueDepth} waiting). ` +
                'Raise maxQueueDepth, slow the producer, or reject earlier — an unbounded ' +
                'queue would trade this error for unbounded memory.',
              {key}
            ),
            'queue-full'
          );
          return;
        }

        markQueued();
        if (emitter.active) {
          emitter.emit(
            sealEvent({
              at: clock.now(),
              key,
              scope: 'process',
              kind: 'queued',
              depth: partition.queue.size,
            })
          );
        }
        armDeadline();
        pump(partition, context);
      });
    },

    stats: (): LimiterStats => ({
      keys: registry.size,
      queued: registry.totalQueued(),
      inflight: registry.totalInflight(),
      backingOff: registry.totalBackingOff(),
      decisionHookErrors: emitter.failures,
    }),

    drain: async () => {
      // A snapshot, so calls submitted during the drain are not part of this
      // barrier. Each invocation gets its own, which makes repeated and
      // overlapping drains independent.
      //
      // `done` never rejects, so neither does this: a drain reports that work
      // has finished, not whether it succeeded.
      await Promise.all([...live]);
    },

    inspect: (key = ''): KeySnapshot => {
      if (typeof key !== 'string') {
        throw new QuotaPilotConfigError(
          `inspect() key must be a string, received ${JSON.stringify(key)}.`
        );
      }
      return inspectKey(key, inspectContext);
    },

    warnings,
  };

  /**
   * `onSaturated: 'reject'` — start now, or fail now.
   *
   * The call is NEVER enqueued on this path, so there is nothing to leak: no
   * queue entry, no timer, no slot, and the promise always settles here.
   *
   * A non-empty queue is an automatic refusal. Admitting ahead of it would
   * break per-key FIFO, and this is not hypothetical: a cheap call can be
   * admissible while a more expensive queued call is not, so without this
   * check a stream of small `'reject'` calls could starve a large queued one
   * indefinitely.
   */
  function rejectOrStart(
    partition: Partition,
    call: QueuedCall,
    key: string,
    refuse: (error: unknown, reason: RefusalReason) => void
  ): void {
    if (!partition.queue.isEmpty) {
      refuse(
        new QuotaPilotSaturatedError(
          `Key ${JSON.stringify(key)} already has ${partition.queue.size} call(s) queued. ` +
            'Rejecting rather than starting ahead of them, which would break FIFO order.',
          {kind: 'queued-ahead', waitMs: 0, binding: 'queue', key}
        ),
        'saturated'
      );
      return;
    }

    const outcome = tryAdmit(partition, call.cost, clock.now(), context);
    if (!outcome.admitted) {
      // Nothing was taken (S5), so there is nothing to undo.
      refuse(saturated(outcome, key), 'saturated');
      return;
    }

    // Same order the pump uses: count in before starting, so a call that
    // settles synchronously sees consistent state.
    partition.inflight++;
    call.start(outcome.release);
  }
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

/** An optional positive-millisecond option. */
function optionalMs(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new QuotaPilotConfigError(
      `run() ${label} must be a finite number greater than 0, received ${JSON.stringify(value)}.`
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
