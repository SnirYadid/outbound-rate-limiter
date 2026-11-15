/**
 * Public types that are settled.
 *
 * Deliberately narrow for this release: types describing behaviour that is not
 * implemented yet (the scheduler, the retry engine, the telemetry event union)
 * are NOT exported, because a published type is a promise and this release
 * cannot keep those yet. They land with the code that implements them.
 */

export type IntervalUnit = 'second' | 'minute' | 'hour' | 'day';

/**
 * One rate limit to respect.
 *
 * A limiter may hold several; all of them must permit a call before it runs.
 *
 * @example
 * // "5 per second, and 100 per minute" — both enforced at once.
 * const constraints = [
 *   {name: 'burst', limit: 5, interval: 'second'},
 *   {name: 'sustained', limit: 100, interval: 'minute'},
 * ];
 */
export interface RateConstraint {
  /**
   * Identifies this constraint in telemetry and errors. Must be unique within
   * a limiter — duplicate names would make "which limit made us wait"
   * unanswerable, which is the question the telemetry exists to answer.
   */
  readonly name: string;

  /** Units admitted per `interval`. Finite and > 0. */
  readonly limit: number;

  /** Milliseconds, or one of the unit aliases. */
  readonly interval: number | IntervalUnit;

  /**
   * Instantaneous burst capacity, in units. Defaults to `limit`.
   *
   * This is also the largest `cost` the constraint can ever admit, so with
   * weighted calls it must be at least your maximum cost.
   *
   * Lowering it reduces how far a burst can overshoot the nominal rate — see
   * docs/GUARANTEES.md for the exact bound. Note that `burst: 1` does NOT give
   * a strict rolling-window limit once costs can exceed one token; the
   * overshoot is bounded by `burst`, and `burst` can never be below your
   * largest cost.
   */
  readonly burst?: number;

  /**
   * Reserved. Only `'bucket'` exists in this release; the field is present so
   * that adding a strategy later is not a breaking change. Omit it.
   */
  readonly strategy?: 'bucket';
}
