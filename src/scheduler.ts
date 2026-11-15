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
import type {Clock} from './time.js';

export interface SchedulerContext extends AdmitContext {
  readonly clock: Clock;
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

      const outcome = tryAdmit(partition, head.cost, context.clock.now(), context);

      if (outcome.admitted) {
        // Dequeue and count the call in BEFORE starting it, so a call that
        // settles synchronously inside `start` sees consistent state when its
        // completion handler decrements and re-pumps.
        partition.queue.dequeue();
        partition.inflight++;
        head.start(outcome.release);
        continue;
      }

      switch (outcome.blockedBy) {
        case 'rate':
          scheduleWake(partition, context, outcome.waitMs);
          return;
        case 'slot':
          // Registered synchronously after the failed tryAcquire: see above.
          context.semaphore.waitForRelease(() => {
            pump(partition, context);
          });
          return;
        case 'key-concurrency':
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
