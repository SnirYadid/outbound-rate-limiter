/**
 * The pump: one per key, driving that key's queue.
 *
 * It is a loop that admits as much as it can and then STOPS, recording what it
 * is waiting for. It is restarted by whichever event can change that answer:
 *
 *   blocked on 'rate'             → a timer, set for exactly the wait the
 *                                   bucket reported
 *   blocked on 'slot'             → the semaphore's FIFO waiter list
 *   blocked on 'key-concurrency'  → completion of one of this key's own calls
 *   queue was empty               → the next enqueue
 *
 * No polling and no busy loop: every stop has a matching wake, and every wake
 * can only be caused by something that genuinely changes eligibility.
 *
 * Lost wake-ups are avoided without a lock, by the one structural rule that
 * the stop and the registration happen in the SAME synchronous turn as the
 * failed admission. Nothing can slip in between on a single-threaded loop.
 * (A spurious wake is always safe: the pump just re-attempts.)
 */

import {tryAdmit, type AdmitContext} from './admit.js';
import type {Partition} from './partition.js';
import {sealEvent} from './telemetry.js';
import type {Clock} from './time.js';
import type {Decision, SaturationKind} from './types.js';

export interface SchedulerContext extends AdmitContext {
  readonly clock: Clock;
  /** Publishes a decision event. Never throws. */
  readonly emit: (event: Decision) => void;
  /** True when a listener is attached, so events are built only if watched. */
  readonly telemetry: boolean;
}

/**
 * Runs `partition`'s queue as far as capacity allows.
 *
 * Safe to call at any time, including spuriously and re-entrantly: the
 * `pumping` flag collapses a re-entrant call into the loop already running, so
 * a call that completes synchronously inside `start` cannot recurse through
 * its own key.
 */
export function pump(partition: Partition, context: SchedulerContext): void {
  if (partition.pumping) return;
  partition.pumping = true;

  try {
    for (;;) {
      const head = partition.queue.peek();
      if (head === undefined) return;

      const now = context.clock.now();

      // Asked before admission, never after: an expired call must not spend
      // capacity, because capacity is never refunded. Its own deadline timer
      // normally settles it first; this is the guard for the case where the
      // pump reaches it at the same instant.
      if (head.isExpired(now)) {
        partition.queue.dequeue();
        head.expire();
        continue;
      }

      const outcome = tryAdmit(partition, head.cost, now, context);

      if (outcome.admitted) {
        // Dequeue BEFORE starting: a task that settles synchronously inside
        // `start` re-pumps from within this frame, and it must not find itself
        // still at the head of the queue.
        //
        // `start` takes it from here — it counts itself into `inflight` and
        // owns the release. See the comment there for why that side of the
        // accounting does not live at the admission sites.
        partition.queue.dequeue();
        head.start(outcome.release);
        continue;
      }

      switch (outcome.blockedBy) {
        case 'rate':
          publishDelay(partition, context, head.attemptsMade(), {
            cause: 'rate',
            binding: outcome.binding,
            waitMs: outcome.waitMs,
          });
          scheduleWake(partition, context, outcome.waitMs);
          return;
        case 'slot':
          publishDelay(partition, context, head.attemptsMade(), {
            cause: 'concurrency',
            binding: 'maxConcurrent',
            waitMs: 0,
          });
          // Registered synchronously after the failed tryAcquire: see above.
          context.semaphore.waitForRelease(() => {
            pump(partition, context);
          });
          return;
        case 'key-concurrency':
          publishDelay(partition, context, head.attemptsMade(), {
            cause: 'key-concurrency',
            binding: 'maxConcurrentPerKey',
            waitMs: 0,
          });
          // Nothing to register. This key has calls in flight, and each one
          // re-pumps when it settles.
          return;
      }
    }
  } finally {
    partition.pumping = false;
  }
}

/**
 * Reports that the scheduler has stopped to wait, and on what.
 *
 * Emitted after the decision not to admit is final — the pump is about to
 * return — so a listener never observes a half-made decision.
 */
function publishDelay(
  partition: Partition,
  context: SchedulerContext,
  attempt: number,
  detail: {cause: SaturationKind; binding: string; waitMs: number}
): void {
  if (!context.telemetry) return;
  const event: Decision = {
    at: context.clock.now(),
    key: partition.key,
    scope: 'process',
    kind: 'delayed',
    cause: detail.cause,
    binding: detail.binding,
    waitMs: detail.waitMs,
    attempt,
  };
  context.emit(sealEvent(event));
}

/**
 * Discards a pending rate wake.
 *
 * Needed when a call leaves the queue without being admitted (its budget ran
 * out): the pending timer was computed for that head, and the new head may
 * need a different wait. Cancelling and letting the next pump recompute is
 * always correct; keeping it risks sleeping longer than the new head needs.
 */
export function cancelWake(partition: Partition): void {
  if (partition.wakeTimer === undefined) return;
  partition.wakeTimer();
  partition.wakeTimer = undefined;
}

/**
 * Sleeps until rate capacity returns.
 *
 * At most one timer per partition. A second request is a no-op rather than a
 * replacement: only the pump schedules these, only one pump runs per
 * partition, and the head of a FIFO cannot change while it is rate-blocked —
 * so an already-pending timer is always for the same wait.
 */
function scheduleWake(partition: Partition, context: SchedulerContext, waitMs: number): void {
  if (partition.wakeTimer !== undefined) return;

  partition.wakeTimer = context.clock.setTimer(() => {
    // Cleared before pumping, so the partition is not considered "waiting" by
    // the eviction check while the pump is actually running.
    partition.wakeTimer = undefined;
    pump(partition, context);
  }, waitMs);
}
