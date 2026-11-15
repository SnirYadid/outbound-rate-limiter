/**
 * One logical call, across however many attempts it takes.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE FIVE STATES, AND WHO PROTECTS THE PARTITION IN EACH
 *
 *   queued       → a queue entry       (queue is non-empty)
 *   in flight    → a concurrency slot  (inflight > 0)
 *   backing off  → `backingOff`        (NOTHING else: no queue entry, no slot)
 *   re-queued    → a queue entry
 *   settled      → nothing, and nothing needed
 *
 * The third state is the dangerous one. A sleeping retry holds no queue entry
 * and no slot, so without `backingOff` it satisfies every condition for its
 * partition to be evicted — and then it re-enters an ORPHANED partition while
 * a fresh call mints a new, full one. Two partitions would then enforce one
 * key's limit independently, silently doubling it for keys that retried.
 *
 * Hence `backingOff`, and hence the ordering in `scheduleRetry`: the call is
 * put back in the queue BEFORE the counter is dropped, so there is never an
 * instant where neither protects the partition.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Settlement is tracked at two levels, because they answer different
 * questions. Per ATTEMPT (`attemptDone`): who owns this attempt's outcome, so
 * the concurrency slot is released exactly once even when a timeout and a late
 * resolution race. Per CALL (`settled`): whether the caller's promise has been
 * answered, so a straggler from a timed-out attempt can never override the
 * result of a later one.
 */

import {QuotaPilotBudgetError, QuotaPilotTimeoutError} from './errors.js';
import type {Partition, QueuedCall} from './partition.js';
import {computeBackoffMs, providerHintMs, type NormalizedRetryPolicy} from './retry.js';
import type {RandomFn} from './random.js';
import type {Release} from './semaphore.js';
import type {Clock} from './time.js';
import type {AttemptContext, Verdict} from './types.js';

export interface CallSpec<T> {
  readonly key: string;
  readonly cost: number;
  readonly fn: (context: AttemptContext) => T | Promise<T>;
  readonly retry: NormalizedRetryPolicy | undefined;
  readonly attemptTimeoutMs: number | undefined;
  readonly totalBudgetMs: number | undefined;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

export interface CallEnvironment {
  readonly clock: Clock;
  readonly random: RandomFn;
  readonly partition: Partition;
  /** Runs this partition's pump. */
  readonly repump: () => void;
  /**
   * Cancels this partition's rate wake timer. Needed when a call leaves the
   * queue without being admitted: a timer computed for the old head may be
   * wrong for the new one, so it is discarded and the pump recomputes.
   */
  readonly cancelWake: () => void;
}

export interface BuiltCall {
  readonly call: QueuedCall;
  /**
   * Arms the budget deadline. The caller invokes this immediately after a
   * successful enqueue; retries re-arm it themselves. Kept off `QueuedCall`
   * because the queue and the pump have no business with it.
   */
  readonly armDeadline: () => void;
}

export function createCall<T>(spec: CallSpec<T>, env: CallEnvironment): BuiltCall {
  const {clock, random, partition} = env;
  const startedAt = clock.now();

  let attempts = 0;
  let settled = false;
  let deadlineTimer: (() => void) | undefined;
  /** The last error an attempt produced, carried as `cause` on a budget refusal. */
  let lastError: unknown;

  const elapsed = (): number => clock.now() - startedAt;

  const cancelDeadline = (): void => {
    if (deadlineTimer === undefined) return;
    deadlineTimer();
    deadlineTimer = undefined;
  };

  /** Answers the caller's promise, at most once, and tidies up. */
  const settle = (answer: () => void): void => {
    // Unreachable today: every caller is already behind `claimAttempt` or an
    // explicit `settled` check. Kept because it is the structural guarantee
    // that the caller's promise settles at most once — and Day 5's abort adds
    // a settle path that does not go through an attempt at all.
    /* c8 ignore next */
    if (settled) return;
    settled = true;
    cancelDeadline();
    answer();
  };

  const budgetRefusal = (): QuotaPilotBudgetError =>
    new QuotaPilotBudgetError(
      `Total budget of ${String(spec.totalBudgetMs)}ms for key ` +
        `${JSON.stringify(spec.key)} elapsed after ${attempts} attempt(s).`,
      {
        key: spec.key,
        attempt: attempts,
        elapsedMs: elapsed(),
        ...(lastError !== undefined ? {cause: lastError} : {}),
      }
    );

  /**
   * Arms the deadline so a QUEUED call settles on time without waiting for
   * admission. Without this, a call behind a long rate wait would hold its
   * caller well past the budget it asked for.
   *
   * Armed only while queued. An attempt already in flight is never aborted by
   * the budget — `attemptTimeoutMs` is the tool for bounding one attempt — and
   * a backoff is pre-checked to fit inside the budget before it is scheduled.
   */
  const armDeadline = (): void => {
    if (spec.totalBudgetMs === undefined || deadlineTimer !== undefined || settled) return;
    const remaining = Math.max(0, spec.totalBudgetMs - elapsed());

    deadlineTimer = clock.setTimer(() => {
      deadlineTimer = undefined;
      // Both guards are unreachable today, because the deadline is cancelled
      // the moment an attempt starts — so it cannot fire against a call that
      // has been admitted or settled. They are the reason that cancellation
      // can be removed later without this timer becoming a hazard.
      /* c8 ignore next 2 */
      if (settled) return;
      if (!partition.queue.remove(call)) return;
      env.cancelWake();
      settle(() => {
        spec.reject(budgetRefusal());
      });
      env.repump();
    }, remaining);
  };

  /** True when the deadline has passed. Read by the pump before admitting. */
  const isExpired = (now: number): boolean =>
    spec.totalBudgetMs !== undefined && now - startedAt >= spec.totalBudgetMs;

  /**
   * The pump dropped this call because `isExpired` said so. It has already
   * been dequeued; all that is left is to answer the caller.
   *
   * This exists alongside the deadline timer on purpose. The timer makes the
   * refusal prompt; this makes it impossible for an expired call to spend
   * capacity, which matters because capacity is never refunded.
   */
  const expire = (): void => {
    settle(() => {
      spec.reject(budgetRefusal());
    });
  };

  const scheduleRetry = (delayMs: number): void => {
    // Claim protection BEFORE sleeping: from here until the call is back in a
    // queue, this counter is the only thing keeping the partition alive.
    partition.backingOff++;

    clock.setTimer(() => {
      // Re-queue FIRST, drop the counter SECOND. Reversing these two lines
      // opens exactly the eviction window this counter exists to close.
      partition.queue.requeue(call);
      partition.backingOff--;
      armDeadline();
      env.repump();
    }, delayMs);
  };

  /**
   * An attempt failed. Decide between retrying and answering the caller.
   *
   * On ordinary exhaustion the CALLER's error surfaces unchanged (D7): wrapping
   * it would break `instanceof` and `.status` checks in their code.
   */
  const decide = (error: unknown, timedOut: boolean): void => {
    lastError = error;
    const policy = spec.retry;
    if (policy === undefined) {
      settle(() => {
        spec.reject(error);
      });
      return;
    }

    let verdict: Verdict;
    try {
      verdict = policy.classify(error, {attempt: attempts, elapsedMs: elapsed(), timedOut});
    } catch {
      // A classifier that throws is a bug in the caller's code, and it must
      // not be allowed to invent a different outcome for the call. So: do not
      // retry, and surface the error the operation actually produced.
      settle(() => {
        spec.reject(error);
      });
      return;
    }

    if (!verdict.retry || attempts >= policy.maxAttempts) {
      settle(() => {
        spec.reject(error);
      });
      return;
    }

    const delayMs = providerHintMs(verdict) ?? computeBackoffMs(attempts, policy, random);

    // Budget checkpoint one of two: never sleep past the deadline.
    if (spec.totalBudgetMs !== undefined && elapsed() + delayMs >= spec.totalBudgetMs) {
      settle(() => {
        spec.reject(budgetRefusal());
      });
      return;
    }

    scheduleRetry(delayMs);
  };

  const start = (release: Release): void => {
    // The budget does not police an attempt that is already running, so the
    // queue deadline is stood down for its duration and re-armed if the call
    // comes back for another go.
    cancelDeadline();

    attempts++;
    const attemptNumber = attempts;
    let attemptDone = false;
    let timeoutTimer: (() => void) | undefined;

    /**
     * Claims this attempt's outcome. Returns false when something else already
     * claimed it — which is how a late resolution after a timeout is ignored
     * and, critically, how the slot is released exactly once.
     */
    const claimAttempt = (): boolean => {
      if (attemptDone) return false;
      attemptDone = true;
      if (timeoutTimer !== undefined) {
        timeoutTimer();
        timeoutTimer = undefined;
      }
      partition.inflight--;
      // Per-key capacity first, then the global slot: releasing the slot can
      // hand it straight to another key's pump, which should see this key's
      // count already decremented.
      release();
      env.repump();
      return true;
    };

    if (spec.attemptTimeoutMs !== undefined) {
      const timeoutMs = spec.attemptTimeoutMs;
      timeoutTimer = clock.setTimer(() => {
        timeoutTimer = undefined;
        const timeoutError = new QuotaPilotTimeoutError(
          `Attempt ${attemptNumber} for key ${JSON.stringify(spec.key)} exceeded ` +
            `${timeoutMs}ms and was abandoned. Whether the operation completed is UNKNOWN.`,
          {timeoutMs, key: spec.key, attempt: attemptNumber, elapsedMs: elapsed()}
        );
        // Unreachable today: `claimAttempt` cancels this timer, so it cannot
        // fire for an attempt that already finished. It is what makes the
        // timeout-versus-late-finish race safe by construction rather than by
        // argument.
        /* c8 ignore next */
        if (!claimAttempt()) return;

        // Retrying an attempt QuotaPilot itself abandoned is opt-in (D4): the
        // server may have completed the work, so repeating it by default would
        // make this library silently unsafe for anything non-idempotent.
        if (spec.retry?.retryOnAttemptTimeout === true) {
          decide(timeoutError, true);
        } else {
          settle(() => {
            spec.reject(timeoutError);
          });
        }
      }, timeoutMs);
    }

    const attemptContext: AttemptContext = {
      key: spec.key,
      attempt: attemptNumber,
      elapsedMs: elapsed(),
    };

    let result: T | Promise<T>;
    try {
      result = spec.fn(attemptContext);
    } catch (error) {
      // A synchronous throw still spent capacity and a slot. Both are
      // accounted for; capacity is never refunded (G7).
      //
      // The guard is unreachable here — the attempt was started in this same
      // turn, so nothing can have claimed it — but `claimAttempt` is the only
      // sanctioned way to release a slot, and bypassing it would be the kind
      // of shortcut that leaks one.
      /* c8 ignore next */
      if (!claimAttempt()) return;
      decide(error, false);
      return;
    }

    // `.then(onOk, onErr)` rather than a bare `.then`: both outcomes are
    // handled here, so an abandoned attempt's late rejection can never become
    // an unhandled rejection and take the process down.
    Promise.resolve(result).then(
      (value) => {
        if (!claimAttempt()) return;
        settle(() => {
          spec.resolve(value);
        });
      },
      (error: unknown) => {
        if (!claimAttempt()) return;
        decide(error, false);
      }
    );
  };

  const call: QueuedCall = {
    cost: spec.cost,
    enqueuedAt: startedAt,
    isExpired,
    expire,
    start,
  };

  return {call, armDeadline};
}
