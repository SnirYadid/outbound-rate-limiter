/**
 * A deterministic clock for tests. Test-only: never shipped.
 *
 * The one subtlety that makes or breaks this harness: advancing time must let
 * the PROMISE chain attached to each fired timer run before the next timer
 * fires. A naive `advance` that fires every due timer in a tight loop looks
 * correct and then deadlocks the moment a timer's callback resolves a promise
 * whose continuation schedules the next timer — which is exactly the shape of
 * every wait loop in this library.
 *
 * So `advance` is async and yields to the macrotask queue after each firing,
 * which flushes all pending microtasks. That uses one real `setImmediate` per
 * step; the time the library observes is still entirely virtual.
 */

import type {Clock} from '../../src/time.js';

interface ScheduledTimer {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
  cancelled: boolean;
}

export interface VirtualClock extends Clock {
  /**
   * Moves time forward by `ms`, firing every timer that comes due in
   * chronological order and flushing microtasks between firings.
   */
  advance(ms: number): Promise<void>;
  /** Moves time forward to exactly the next due timer. No-op when idle. */
  advanceToNextTimer(): Promise<void>;
  /** Runs every outstanding timer, however far in the future. */
  runAll(): Promise<void>;
  /** Count of scheduled, uncancelled timers. */
  pendingTimers(): number;
  /** Virtual time of the earliest outstanding timer, or `undefined` when idle. */
  nextTimerAt(): number | undefined;
  /** Yields to the macrotask queue so pending promise chains settle. */
  flush(): Promise<void>;
}

export function createVirtualClock(start = 0): VirtualClock {
  let current = start;
  let nextId = 1;
  let timers: ScheduledTimer[] = [];

  const live = (): ScheduledTimer[] => timers.filter((t) => !t.cancelled);

  const flush = (): Promise<void> =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

  const fireDueUpTo = async (target: number): Promise<void> => {
    // Re-read the queue every iteration: a fired callback may schedule more.
    for (;;) {
      const due = live()
        .filter((t) => t.at <= target)
        .sort((a, b) => (a.at === b.at ? a.id - b.id : a.at - b.at));
      const next = due[0];
      if (next === undefined) break;

      next.cancelled = true;
      timers = timers.filter((t) => t.id !== next.id);
      // Time is the firing time, not the target: a callback reading `now()`
      // must see when it was scheduled for, not where the advance is heading.
      current = Math.max(current, next.at);
      next.fn();
      await flush();
    }
    current = Math.max(current, target);
  };

  return {
    now: () => current,

    setTimer: (fn, ms) => {
      const timer: ScheduledTimer = {
        id: nextId++,
        // A non-positive or non-finite delay fires at the current instant on
        // the next step, matching how `setTimeout` treats 0 and negatives.
        at: current + (Number.isFinite(ms) && ms > 0 ? ms : 0),
        fn,
        cancelled: false,
      };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
        timers = timers.filter((t) => t.id !== timer.id);
      };
    },

    advance: async (ms) => {
      await fireDueUpTo(current + Math.max(0, ms));
    },

    advanceToNextTimer: async () => {
      const upcoming = live().reduce<number | undefined>(
        (min, t) => (min === undefined || t.at < min ? t.at : min),
        undefined
      );
      if (upcoming === undefined) return;
      await fireDueUpTo(upcoming);
    },

    runAll: async () => {
      // Bounded so a self-rescheduling timer fails the test instead of hanging it.
      for (let step = 0; step < 10_000; step++) {
        const upcoming = live().reduce<number | undefined>(
          (min, t) => (min === undefined || t.at < min ? t.at : min),
          undefined
        );
        if (upcoming === undefined) return;
        await fireDueUpTo(upcoming);
      }
      throw new Error('VirtualClock.runAll: timers kept rescheduling after 10000 steps');
    },

    pendingTimers: () => live().length,

    nextTimerAt: () =>
      live().reduce<number | undefined>(
        (min, t) => (min === undefined || t.at < min ? t.at : min),
        undefined
      ),

    flush,
  };
}
