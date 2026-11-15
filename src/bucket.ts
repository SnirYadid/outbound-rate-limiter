/**
 * The weighted token bucket. Pure, synchronous, no clock of its own.
 *
 * Every function here takes `now` as an argument and returns new state. That
 * is not stylistic: it is what lets the scheduler run a multi-constraint
 * check-and-consume as ONE synchronous block with no `await` inside it, which
 * is where QuotaPilot's atomicity guarantee comes from.
 *
 * The guarantees this module provides, and what they do NOT cover, are stated
 * in docs/GUARANTEES.md. The short version:
 *
 *   over any window [t1, t2],  total admitted cost <= capacity + rate*(t2-t1)
 *
 * That bound is tight, it holds for heterogeneous costs, and it is the only
 * quantitative claim QuotaPilot makes about a constraint.
 */

/**
 * Comparison tolerance, in tokens.
 *
 * Token counts are floats, so `tokens >= cost` needs slack or a request can
 * stall forever a hair short of its cost after a long accumulation of rounding
 * error. The consequence is bounded and documented: admission may occur up to
 * EPS tokens early. With EPS at 1e-9 and costs of order 1, that is roughly a
 * billionth of one request's worth of capacity per admission.
 *
 * Integer micro-token scaling was considered and rejected: it moves the error
 * rather than removing it (the rate must still be scaled and rounded), and it
 * adds a conversion layer to every arithmetic site for no observable gain.
 */
export const TOKEN_EPSILON = 1e-9;

/** A bucket's fixed parameters. Derived from a `RateConstraint`. */
export interface BucketSpec {
  /** Maximum tokens held. Finite, > 0. Also the largest admissible cost. */
  readonly capacity: number;
  /** Tokens restored per millisecond. Finite, > 0. */
  readonly ratePerMs: number;
}

/** A bucket's mutable state. Treated as immutable; every function returns new state. */
export interface BucketState {
  /** Tokens currently held. Always within `[0, capacity]`. */
  readonly tokens: number;
  /** The reading of `now` at which `tokens` was last computed. */
  readonly updatedAt: number;
}

export interface PeekResult {
  /** True when `cost` can be taken right now. */
  readonly ok: boolean;
  /**
   * The bucket advanced to `now`, with nothing consumed. Pass this to
   * `commit` so the scheduler refills once and writes once.
   */
  readonly refilled: BucketState;
  /** Tokens available after refill, before any consumption. */
  readonly available: number;
  /**
   * Milliseconds until `cost` would be available. `0` when `ok`.
   * `Infinity` when `unsatisfiable`.
   */
  readonly waitMs: number;
  /**
   * `cost` exceeds `capacity`, so no amount of waiting will ever admit it.
   * Callers must turn this into a configuration error, never a wait — an
   * unsatisfiable request that merely waits is an unkillable hang.
   */
  readonly unsatisfiable: boolean;
}

/**
 * A new bucket starts FULL.
 *
 * This is what makes key eviction safe: a key nobody has seen has consumed
 * nothing, so creating it full is the honest initial state — and therefore a
 * bucket that has refilled to capacity carries no information and can be
 * dropped without handing out capacity. See docs/GUARANTEES.md.
 */
export function createBucket(now: number, spec: BucketSpec): BucketState {
  return {tokens: spec.capacity, updatedAt: now};
}

/**
 * Advances a bucket to `now`.
 *
 * Returns the SAME object when nothing changed, so a caller can cheaply tell
 * whether the advance was a no-op.
 *
 * A `now` earlier than `updatedAt` (a wall-clock `now` moved backwards by an
 * NTP correction) is treated as zero elapsed time and leaves `updatedAt` in
 * place. The bucket therefore stalls until real time passes the stale reading
 * rather than inventing tokens. Stalling under a clock anomaly is recoverable;
 * inflating is a quota breach.
 */
export function refill(state: BucketState, now: number, spec: BucketSpec): BucketState {
  const elapsed = elapsedSince(state.updatedAt, now);
  if (elapsed === 0) {
    // Still clamp: guards a hand-constructed state that violates the bound.
    const clamped = clampTokens(state.tokens, spec);
    return clamped === state.tokens ? state : {tokens: clamped, updatedAt: state.updatedAt};
  }
  const tokens = clampTokens(state.tokens + elapsed * spec.ratePerMs, spec);
  return {tokens, updatedAt: now};
}

/**
 * Asks whether `cost` can be taken, without taking it.
 *
 * Pure: calling this a thousand times changes nothing an observer can see.
 * `inspect()` is built on it for exactly that reason.
 */
export function peek(
  state: BucketState,
  now: number,
  cost: number,
  spec: BucketSpec
): PeekResult {
  const refilled = refill(state, now, spec);
  const available = refilled.tokens;

  if (cost > spec.capacity + TOKEN_EPSILON) {
    return {ok: false, refilled, available, waitMs: Infinity, unsatisfiable: true};
  }
  if (available + TOKEN_EPSILON >= cost) {
    return {ok: true, refilled, available, waitMs: 0, unsatisfiable: false};
  }

  // Ceil so a sub-millisecond deficit still waits a whole tick, and floor the
  // result at 1: returning 0 here would spin the scheduler.
  const waitMs = Math.max(1, Math.ceil((cost - available) / spec.ratePerMs));
  return {ok: false, refilled, available, waitMs, unsatisfiable: false};
}

/**
 * Takes `cost` from an already-refilled bucket.
 *
 * Expects the `refilled` state from a `peek` that returned `ok`, so refilling
 * happens once per admission rather than twice.
 *
 * There is no inverse. Tokens are never returned — not when the attempt fails,
 * not when it times out, not when it is cancelled mid-flight. A refund would
 * mean a failed request cost the provider nothing, which is false: the request
 * was sent.
 */
export function commit(refilled: BucketState, cost: number, spec: BucketSpec): BucketState {
  return {tokens: clampTokens(refilled.tokens - cost, spec), updatedAt: refilled.updatedAt};
}

/**
 * Milliseconds until the bucket is back at capacity. `0` when it already is.
 *
 * This is the eviction predicate: a bucket reading `0` here is at capacity, so
 * dropping it is observationally identical to keeping it.
 */
export function msUntilFull(state: BucketState, now: number, spec: BucketSpec): number {
  const deficit = spec.capacity - refill(state, now, spec).tokens;
  return deficit <= TOKEN_EPSILON ? 0 : Math.ceil(deficit / spec.ratePerMs);
}

/** True when the bucket holds full capacity as of `now`. */
export function isFull(state: BucketState, now: number, spec: BucketSpec): boolean {
  return msUntilFull(state, now, spec) === 0;
}

function clampTokens(tokens: number, spec: BucketSpec): number {
  if (!Number.isFinite(tokens)) {
    // +Infinity arises from an infinite elapsed time; NaN only from a
    // hand-constructed state. Both resolve to "as full as possible", which is
    // the only reading that cannot under-report consumption.
    return tokens > 0 ? spec.capacity : 0;
  }
  if (tokens < 0) return 0;
  if (tokens > spec.capacity) return spec.capacity;
  return tokens;
}

function elapsedSince(updatedAt: number, now: number): number {
  const delta = now - updatedAt;
  if (Number.isFinite(delta)) return delta > 0 ? delta : 0;
  // NaN compares false, so a NaN delta becomes 0 elapsed (stall, not inflate).
  return delta > 0 ? Infinity : 0;
}
