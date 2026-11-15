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
   * Must be a finite number greater than zero. Fractional costs are allowed.
   * Must not exceed any constraint's `burst`, or it could never be admitted;
   * that is rejected synchronously rather than waited on.
   */
  readonly cost?: number;

  /**
   * What to do when the call cannot start immediately. Defaults to `'wait'`.
   *
   * `'wait'` queues the call and runs it when capacity arrives.
   *
   * `'reject'` means "start now or fail now": the call is never queued, so it
   * holds no capacity, no slot and no timer. The returned promise rejects with
   * `QuotaPilotSaturatedError`, whose `kind` says what stopped it.
   *
   * Note that `'reject'` also refuses when the key already has calls queued,
   * reported as `kind: 'queued-ahead'`. Starting ahead of them would break
   * per-key FIFO order, and a cheaper call genuinely can be admissible while a
   * more expensive queued call is not.
   */
  readonly onSaturated?: 'wait' | 'reject';
}

/**
 * What stopped a call under `onSaturated: 'reject'`.
 *
 * Each kind resolves differently, which is why they are distinguished:
 * `'rate'` clears with the passage of time, the concurrency kinds clear when
 * other calls finish, and `'queued-ahead'` clears when the key's own backlog
 * drains.
 */
export type SaturationKind =
  /** A rate constraint had no capacity for this cost. */
  | 'rate'
  /** The limiter-wide `maxConcurrent` cap was full. */
  | 'concurrency'
  /** This key's own `maxConcurrentPerKey` cap was full. */
  | 'key-concurrency'
  /** The key already had queued calls, and jumping them would break FIFO. */
  | 'queued-ahead';

/** One constraint's capacity, as of the moment `inspect()` was called. */
export interface ConstraintSnapshot {
  /** The constraint's configured name. */
  readonly name: string;
  /** Units available right now, after accounting for elapsed time. */
  readonly available: number;
  /** The constraint's `burst` — the most it can ever hold. */
  readonly capacity: number;
  /** Milliseconds until `available` reaches `capacity`. `0` when already full. */
  readonly msUntilFull: number;
}

/**
 * A point-in-time view of one key. Returned by `inspect()`.
 *
 * Everything here is a copy. Nothing in it references live internal state, and
 * producing it changes nothing — see the `inspect()` contract.
 */
export interface KeySnapshot {
  readonly key: string;
  /**
   * `false` when the limiter has never seen this key. The figures are then the
   * hypothetical state it WOULD start in — full capacity, nothing queued —
   * because inspecting a key must not bring it into existence.
   */
  readonly tracked: boolean;
  /** Calls waiting for capacity under this key. */
  readonly queued: number;
  /** Calls started under this key and not yet settled. */
  readonly inflight: number;
  /**
   * True when this key's scheduler is sleeping until rate capacity returns.
   * Distinguishes "waiting on the clock" from "waiting on other calls".
   */
  readonly waitingForCapacity: boolean;
  /** One entry per constraint, in declaration order. */
  readonly constraints: readonly ConstraintSnapshot[];
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
   * A side-effect-free snapshot of one key's capacity and scheduler state.
   *
   * The contract, and the reason this is safe to call from a health endpoint
   * or a hot loop: **calling `inspect()` never changes a future admission
   * outcome or when it happens.** It consumes no capacity, commits no refill,
   * enqueues nothing, schedules no timer, alters no eviction eligibility, and
   * does not bring an unseen key into existence.
   *
   * Defaults to the same key `run()` does (`''`).
   */
  inspect(key?: string): KeySnapshot;

  /**
   * Configuration that is legal but probably not what you meant — most often a
   * constraint whose window outlives the process. Data rather than log output,
   * so you decide whether and how to surface it.
   */
  readonly warnings: readonly string[];
}
