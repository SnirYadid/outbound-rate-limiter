/**
 * Public types that are settled.
 *
 * Deliberately narrow: types describing behaviour that is not implemented yet
 * (the retry policy, the telemetry event union) are NOT exported, because a
 * published type is a promise. They land with the code that implements them,
 * and every one of them is an ADDITIVE change to the shapes below — a new
 * optional field on `RunOptions`, a new property on `AttemptContext` — so
 * nothing here has to move.
 */

import type {Clock} from './time.js';

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

/** What a running call is told about its own execution. */
export interface AttemptContext {
  /** The partition key this call was admitted under. */
  readonly key: string;
  /**
   * Milliseconds between entering the queue and starting. In other words, how
   * long this call waited for capacity.
   */
  readonly elapsedMs: number;
}

export interface RunOptions {
  /**
   * Partitions every constraint. Calls under different keys hold entirely
   * separate capacity. Defaults to `''`, one shared partition.
   *
   * Pick something stable and coarse — a credential or an account, not a
   * request id. Every distinct key is a tracked partition, bounded by
   * `maxKeys`.
   */
  readonly key?: string;
  /**
   * Units this call consumes from every constraint. Defaults to `1`.
   *
   * Must not exceed any constraint's `burst`, or it could never be admitted;
   * that is rejected synchronously rather than waited on.
   */
  readonly cost?: number;
}

export interface LimiterStats {
  /** Partitions currently tracked. */
  readonly keys: number;
  /** Calls waiting for capacity, across all keys. */
  readonly queued: number;
  /** Calls started and not yet settled, across all keys. */
  readonly inflight: number;
}

export interface LimiterOptions {
  /** Every constraint must permit a call before it runs. At least one. */
  readonly constraints: readonly RateConstraint[];

  /**
   * Maximum calls running at once across all keys. Defaults to no limit.
   *
   * When slots are scarce they are handed out in the order keys became
   * capacity-eligible, so a busy key cannot starve a quiet one.
   */
  readonly maxConcurrent?: number;

  /** Maximum calls running at once under any single key. Defaults to no limit. */
  readonly maxConcurrentPerKey?: number;

  /**
   * Maximum calls queued per key before `run()` rejects with
   * `QuotaPilotQueueFullError`. Defaults to 1024.
   *
   * Finite by design: an unbounded queue trades a clear error for unbounded
   * memory.
   */
  readonly maxQueueDepth?: number;

  /**
   * Maximum partitions tracked at once. Defaults to 10,000.
   *
   * When the registry is full, QuotaPilot evicts only partitions whose
   * capacity has fully recovered and which have no queued or running work —
   * dropping one of those is unobservable. If none qualifies, `run()` rejects
   * with `QuotaPilotKeyLimitError` rather than discarding capacity that is
   * still owed.
   */
  readonly maxKeys?: number;

  /**
   * How often an eviction sweep may run, in milliseconds. Defaults to the
   * longest time any constraint needs to refill from empty, which is the
   * soonest a drained partition could become disposable.
   *
   * `0` sweeps whenever a new key appears; `Infinity` never sweeps on a
   * schedule. A sweep is forced regardless when the registry is full.
   */
  readonly sweepIntervalMs?: number;

  /**
   * Time source. Defaults to a monotonic real clock.
   *
   * Replace it to make tests deterministic — QuotaPilot reads no other clock,
   * so with an injected one no test ever has to sleep.
   */
  readonly clock?: Clock;
}

export interface Limiter {
  /**
   * Runs `fn` once capacity allows, and resolves with its result.
   *
   * Waits by default: a call with no capacity is queued, not refused. It
   * rejects with a `QuotaPilot*` error when the limiter itself refuses (a full
   * queue, an untrackable key), and with whatever `fn` threw otherwise. There
   * are no retries in this release — `fn` runs exactly once.
   */
  run<T>(fn: (ctx: AttemptContext) => T | Promise<T>, options?: RunOptions): Promise<T>;

  /** A point-in-time count of tracked keys, queued calls and running calls. */
  stats(): LimiterStats;

  /**
   * Configuration that is legal but probably not what you meant — most often a
   * constraint whose window outlives the process. Data rather than log output,
   * so you decide whether and how to surface it.
   */
  readonly warnings: readonly string[];
}
