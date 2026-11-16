/**
 * The clock seam.
 *
 * This is the ONLY module in `src/` permitted to name `Date.now`, `setTimeout`
 * or `clearTimeout`. A hygiene test enforces that. Everything else takes a
 * `Clock`, which is what makes the library testable without real time passing.
 */

/** Cancels a pending timer. Idempotent: calling it twice is harmless. */
export type CancelTimer = () => void;

export interface Clock {
  /**
   * Milliseconds, non-decreasing.
   *
   * All of the library's arithmetic is durations, so the reading must never go
   * backwards. `realClock` therefore uses a monotonic source rather than
   * `Date.now()`, which an NTP correction can move backwards. The bucket math
   * is additionally defensive about this (a negative delta is treated as zero
   * elapsed), so a hand-rolled wall-clock `now` is safe but will stall a
   * bucket until real time catches up rather than inflating it.
   */
  now(): number;

  /** Schedules `fn` to run after `ms`. Returns a canceller. */
  setTimer(fn: () => void, ms: number): CancelTimer;
}

/**
 * The production clock.
 *
 * `performance.timeOrigin + performance.now()` is monotonic AND comparable to
 * `Date.now()` (within whatever drift accumulates over the process lifetime),
 * so one reading serves both the duration math and the timestamps on telemetry
 * events. Using two different time concepts for those two jobs was considered
 * and rejected: it doubles the seam for no benefit a caller can observe.
 */
export const realClock: Clock = {
  now: () => performance.timeOrigin + performance.now(),
  setTimer: (fn, ms) => {
    // Deliberately NOT unref'd. An unref'd timer lets Node exit while a caller
    // is still awaiting the promise behind it, which drops the work silently —
    // the worst possible failure for a scheduler. `drain()` is the supported
    // way to reach a clean exit; a pending timer holding the process open is
    // the honest signal that work is still outstanding.
    const handle = setTimeout(fn, ms);
    return () => { clearTimeout(handle); };
  },
};
