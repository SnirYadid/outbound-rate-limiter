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
 *
 * ────────────────────────────────────────────────────────────────────────────
 * RESOURCE OWNERSHIP — every row has ONE owner and ONE release path
 *
 *   queue entry        call, while queued   → admission | deadline | expire | abort
 *   deadline timer     call, while queued   → attempt start | settle | abort
 *   backoff timer      call, while sleeping → timer firing | abort
 *   `backingOff`       call, while sleeping → timer firing | abort
 *   slot + `inflight`  the ATTEMPT          → claimAttempt, exactly once
 *   timeout timer      the ATTEMPT          → claimAttempt
 *   abort listener     call, whole life     → settle
 *
 * The last row is the one that is easy to miss. A caller who reuses one
 * `AbortController` across many calls would otherwise accumulate a listener
 * per call, and each listener retains this whole closure.
 *
 * `state` names which of those a call currently holds, so the abort handler
 * can release exactly the right set. It is updated at every transition and is
 * the single source of truth for cancellation.
 * ────────────────────────────────────────────────────────────────────────────
 */

import {QuotaPilotAbortError, QuotaPilotBudgetError, QuotaPilotTimeoutError} from './errors.js';
import type {Partition, QueuedCall} from './partition.js';
import {computeBackoffMs, providerHintMs, type NormalizedRetryPolicy} from './retry.js';
import {sealEvent} from './telemetry.js';
import type {RandomFn} from './random.js';
import type {Release} from './semaphore.js';
import type {Clock} from './time.js';
import type {AttemptContext, Decision, RefusalReason, Verdict} from './types.js';

export interface CallSpec<T> {
  readonly key: string;
  readonly cost: number;
  readonly fn: (context: AttemptContext) => T | Promise<T>;
  readonly retry: NormalizedRetryPolicy | undefined;
  readonly attemptTimeoutMs: number | undefined;
  readonly totalBudgetMs: number | undefined;
  readonly signal: AbortSignal | undefined;
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
  /** Publishes a decision event. Never throws. */
  readonly emit: (event: Decision) => void;
  /** True when a listener is attached, so events are built only if watched. */
  readonly telemetry: boolean;
}

export interface BuiltCall {
  readonly call: QueuedCall;
  /**
   * Resolves when the call settles, whatever the outcome. Never rejects.
   * `drain()` waits on these.
   */
  readonly done: Promise<void>;
  /**
   * Arms the budget deadline. The caller invokes this immediately after a
   * successful enqueue; retries re-arm it themselves. Kept off `QueuedCall`
   * because the queue and the pump have no business with it.
   */
  readonly armDeadline: () => void;
  /** Records that the call is now queued, so an abort knows what it holds. */
  readonly markQueued: () => void;
  /**
   * Answers the call with a limiter refusal, through the same settle path as
   * every other outcome — so `done` resolves and the call stops being live.
   */
  readonly refuse: (error: unknown, reason: RefusalReason) => void;
}

export function createCall<T>(spec: CallSpec<T>, env: CallEnvironment): BuiltCall {
  const {clock, random, partition} = env;
  const startedAt = clock.now();

  let attempts = 0;
  let settled = false;
  let deadlineTimer: (() => void) | undefined;
  let backoffTimer: (() => void) | undefined;
  /** The last error an attempt produced, carried as `cause` on a budget refusal. */
  let lastError: unknown;

  /**
   * Which resources the call currently holds. The abort handler reads this to
   * release exactly the right set — see the ownership table in the header.
   */
  let state: 'idle' | 'queued' | 'running' | 'backing-off' | 'settled' = 'idle';

  /** The in-flight attempt's handles, so an abort can reach into it. */
  let running: {readonly claim: () => boolean; readonly abort: () => void} | undefined;

  let markDone!: () => void;
  const done = new Promise<void>((resolveDone) => {
    markDone = resolveDone;
  });

  const elapsed = (): number => clock.now() - startedAt;

  const base = (): {at: number; key: string; scope: 'process'} => ({
    at: clock.now(),
    key: spec.key,
    scope: 'process',
  });

  const publish = (event: Decision): void => {
    if (env.telemetry) env.emit(sealEvent(event));
  };

  const cancelDeadline = (): void => {
    if (deadlineTimer === undefined) return;
    deadlineTimer();
    deadlineTimer = undefined;
  };

  /**
   * Answers the caller's promise, at most once, and tidies up.
   *
   * The guard is load-bearing now that an abort can arrive from outside the
   * attempt machinery: abort, timeout, retry and task completion can all race,
   * and exactly one of them gets to answer.
   */
  const settle = (answer: () => void): void => {
    // Unreachable: every caller checks first. Kept because "the caller's
    // promise settles at most once" is a guarantee, and this is the one line
    // that makes it structural rather than a property of five call sites all
    // staying correct.
    /* c8 ignore next */
    if (settled) return;
    settled = true;
    state = 'settled';
    cancelDeadline();
    detachAbort();
    answer();
    // After the caller's promise, so a `drain()` waiter never observes a call
    // as finished before its result is delivered.
    markDone();
  };

  const settleResolved = (value: T): void => {
    settle(() => {
      publish({...base(), kind: 'completed', attempts, elapsedMs: elapsed()});
      spec.resolve(value);
    });
  };

  const settleRejected = (error: unknown, reason: RefusalReason): void => {
    settle(() => {
      publish({...base(), kind: 'refused', reason, attempts, elapsedMs: elapsed()});
      spec.reject(error);
    });
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
      // Unreachable today — the deadline is cancelled the moment an attempt
      // starts — and load-bearing all the same. `settle` already refuses a
      // second settlement, but `settled` is FALSE while an attempt runs, so
      // without this check a stray deadline would reject a caller whose work
      // is still in flight. The queue membership is the thing that
      // distinguishes "still waiting" from "already running".
      /* c8 ignore next */
      if (!partition.queue.remove(call)) return;
      env.cancelWake();
      settleRejected(budgetRefusal(), 'budget');
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
    settleRejected(budgetRefusal(), 'budget');
  };

  const scheduleRetry = (delayMs: number, source: 'backoff' | 'provider-hint'): void => {
    // Claim protection BEFORE sleeping: from here until the call is back in a
    // queue, this counter is the only thing keeping the partition alive.
    partition.backingOff++;
    state = 'backing-off';

    backoffTimer = clock.setTimer(() => {
      backoffTimer = undefined;
      // Re-queue FIRST, drop the counter SECOND. Reversing these two lines
      // opens exactly the eviction window this counter exists to close.
      partition.queue.requeue(call);
      partition.backingOff--;
      state = 'queued';
      armDeadline();
      env.repump();
    }, delayMs);

    publish({...base(), kind: 'retrying', attempt: attempts, delayMs, source});
  };

  /**
   * Releases what a sleeping call holds: the timer, and its claim on the
   * partition. Both, always — cancelling the timer alone would pin the
   * partition forever, and dropping the counter alone would let the timer
   * re-queue a call that has already settled.
   */
  const teardownBackoff = (): void => {
    if (backoffTimer !== undefined) {
      backoffTimer();
      backoffTimer = undefined;
    }
    partition.backingOff--;
  };

  /** The rejection a cancellation produces. */
  const abortError = (): unknown => {
    // The signal's own reason when it has one, so this interoperates with
    // `fetch` and with whatever the caller passed to `abort(reason)`. Node
    // supplies an `AbortError` DOMException for a bare `abort()`, so the
    // fallback is for hand-rolled or older signal implementations.
    const reason: unknown = spec.signal?.reason;
    if (reason !== undefined) return reason;
    return new QuotaPilotAbortError('The call was aborted.', {
      key: spec.key,
      attempt: attempts,
      elapsedMs: elapsed(),
    });
  };

  /**
   * The caller cancelled. Release exactly what this state owns, then answer.
   *
   * Nothing here refunds capacity: an attempt that started spent it, and the
   * request was sent (G7). Everything before an attempt starts has spent
   * nothing, so there is nothing to refund either.
   */
  const onAbort = (): void => {
    if (settled) return;
    const error = abortError();

    switch (state) {
      case 'queued':
        // Leaving the queue without being admitted: drop the entry, and
        // discard a wake computed for a head that is no longer there so the
        // next head is not over-delayed.
        //
        // Not branched on `remove`'s result deliberately. It can only be
        // false if the call were already admitted, which would have moved
        // `state` to 'running' in the same turn — and even then the handling
        // would be identical, since `cancelWake` and `repump` are both safe
        // no-ops. Branching would add a path no test could reach.
        partition.queue.remove(call);
        env.cancelWake();
        settleRejected(error, 'aborted');
        env.repump();
        return;

      case 'backing-off':
        teardownBackoff();
        settleRejected(error, 'aborted');
        return;

      case 'running': {
        const attempt = running;
        // Release the slot first so the limiter stops holding concurrency for
        // work the caller no longer wants, then ask the task to stop, then
        // answer. `claim` is idempotent, so a task that rejects in response to
        // its signal cannot release a second time.
        attempt?.claim();
        attempt?.abort();
        settleRejected(error, 'aborted');
        return;
      }

      /* c8 ignore start */
      case 'idle':
        // Unreachable today: the window between building a call and either
        // enqueuing or starting it contains no `await`, so an abort cannot
        // land inside it. Kept because any future pre-admission step that
        // yields would open that window, and a call aborted there holds
        // nothing and must simply be answered.
        settleRejected(error, 'aborted');
        return;

      default:
        // 'settled', handled by the guard at the top.
        return;
      /* c8 ignore stop */
    }
  };

  const detachAbort = (): void => {
    spec.signal?.removeEventListener('abort', onAbort);
  };

  // Registered for the call's whole life and removed on settle, so a reused
  // AbortController does not accumulate one listener (and one retained
  // closure) per call.
  spec.signal?.addEventListener('abort', onAbort);

  /**
   * An attempt failed. Decide between retrying and answering the caller.
   *
   * On ordinary exhaustion the CALLER's error surfaces unchanged (D7): wrapping
   * it would break `instanceof` and `.status` checks in their code.
   */
  const decide = (error: unknown, timedOut: boolean): void => {
    // Unreachable: an abort while running claims the attempt first, so the
    // task's later rejection is dropped by `claimAttempt` and never reaches
    // here. Kept because without it a retry could be scheduled for a call
    // whose caller has already been answered — which would re-enter the queue
    // and spend capacity nobody is waiting for.
    /* c8 ignore next */
    if (settled) return;

    lastError = error;
    const policy = spec.retry;
    if (policy === undefined) {
      // Not `timedOut ? 'timeout' : 'error'`: a timeout only reaches `decide`
      // when `retryOnAttemptTimeout` is set, which requires a policy. With no
      // policy the timeout path settles directly, so this is always an
      // ordinary task failure.
      settleRejected(error, 'error');
      return;
    }

    let verdict: Verdict;
    try {
      verdict = policy.classify(error, {attempt: attempts, elapsedMs: elapsed(), timedOut});
    } catch {
      // A classifier that throws is a bug in the caller's code, and it must
      // not be allowed to invent a different outcome for the call. So: do not
      // retry, and surface the error the operation actually produced.
      settleRejected(error, 'not-retryable');
      return;
    }

    if (!verdict.retry) {
      settleRejected(error, timedOut ? 'timeout' : 'not-retryable');
      return;
    }
    if (attempts >= policy.maxAttempts) {
      settleRejected(error, 'attempts');
      return;
    }

    const hint = providerHintMs(verdict);
    const delayMs = hint ?? computeBackoffMs(attempts, policy, random);

    // Budget checkpoint one of two: never sleep past the deadline.
    if (spec.totalBudgetMs !== undefined && elapsed() + delayMs >= spec.totalBudgetMs) {
      settleRejected(budgetRefusal(), 'budget');
      return;
    }

    scheduleRetry(delayMs, hint === undefined ? 'backoff' : 'provider-hint');
  };

  const start = (release: Release): void => {
    // The budget does not police an attempt that is already running, so the
    // queue deadline is stood down for its duration and re-armed if the call
    // comes back for another go.
    cancelDeadline();

    attempts++;
    state = 'running';
    const attemptNumber = attempts;
    let attemptDone = false;
    let timeoutTimer: (() => void) | undefined;

    // One controller per attempt, aborted by the caller's signal or by this
    // attempt's timeout. `AbortSignal.any` would express this in one line but
    // landed in Node 20, and the floor here is 18.
    const controller = new AbortController();

    /**
     * Claims this attempt's outcome. Returns false when something else already
     * claimed it — which is how a late resolution after a timeout is ignored
     * and, critically, how the slot is released exactly once.
     */
    const claimAttempt = (): boolean => {
      if (attemptDone) return false;
      attemptDone = true;
      running = undefined;
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

    running = {
      claim: claimAttempt,
      abort: () => {
        controller.abort(abortError());
      },
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
        // Tell the task to stop. It may ignore this, which is why the
        // concurrency guarantee is stated in terms of OBSERVABLE work.
        controller.abort(timeoutError);

        // Retrying an attempt QuotaPilot itself abandoned is opt-in (D4): the
        // server may have completed the work, so repeating it by default would
        // make this library silently unsafe for anything non-idempotent.
        if (spec.retry?.retryOnAttemptTimeout === true) {
          decide(timeoutError, true);
        } else {
          settleRejected(timeoutError, 'timeout');
        }
      }, timeoutMs);
    }

    publish({
      ...base(),
      kind: 'admitted',
      attempt: attemptNumber,
      cost: spec.cost,
      waitedMs: elapsed(),
    });

    const attemptContext: AttemptContext = {
      key: spec.key,
      attempt: attemptNumber,
      elapsedMs: elapsed(),
      signal: controller.signal,
    };

    let result: T | Promise<T>;
    try {
      result = spec.fn(attemptContext);
    } catch (error) {
      // A synchronous throw still spent capacity and a slot. Both are
      // accounted for; capacity is never refunded (G7).
      //
      // Unconditional on purpose. Nothing can have claimed this attempt — it
      // was started in the same synchronous turn — so testing the result
      // would be a branch no test could reach. `claimAttempt` is still the
      // only sanctioned way to release the slot.
      claimAttempt();
      decide(error, false);
      return;
    }

    // `.then(onOk, onErr)` rather than a bare `.then`: both outcomes are
    // handled here, so an abandoned attempt's late rejection can never become
    // an unhandled rejection and take the process down.
    Promise.resolve(result).then(
      (value) => {
        if (!claimAttempt()) return;
        settleResolved(value);
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
    attemptsMade: () => attempts,
    isExpired,
    expire,
    start,
  };

  /** Marks the call as queued. Called by the limiter after a successful enqueue. */
  const markQueued = (): void => {
    if (state === 'idle') state = 'queued';
  };

  /**
   * The limiter refused the call before it ever became live.
   *
   * Routed through `settle` rather than rejecting the promise directly, which
   * is what the first draft did. That left `done` unresolved forever, so
   * `drain()` hung on a call that had already been answered and the limiter's
   * live-call set grew without bound — one leaked entry per refusal.
   */
  const refuse = (error: unknown, reason: RefusalReason): void => {
    settleRejected(error, reason);
  };

  return {call, armDeadline, markQueued, refuse, done};
}
