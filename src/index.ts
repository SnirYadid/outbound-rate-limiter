/**
 * QuotaPilot — outbound API rate limiting, scheduling and retries for Node.
 *
 * The surface below is everything this release line offers: multi-constraint
 * weighted token buckets, keyed partitioning with provably safe eviction,
 * global and per-key concurrency caps, bounded per-key FIFO queueing,
 * classified retries with backoff and provider wait hints, per-attempt
 * timeouts, total budgets, `AbortSignal` cancellation, decision telemetry,
 * `drain()` and `inspect()`.
 *
 * Nothing is exported that is not implemented, and nothing implemented is
 * hidden. The feature set is frozen for 0.1.x.
 *
 * Scope, stated once here and again on the first screen of the README:
 * QuotaPilot bounds outbound traffic from ONE Node process. Run N instances
 * and your real ceiling is N times what you configured. See
 * docs/GUARANTEES.md for what that does and does not promise.
 */

export const VERSION = '0.1.0-alpha.5';

export {createLimiter} from './limiter.js';
export type {
  AttemptContext,
  ClassifyContext,
  ConstraintSnapshot,
  Decision,
  DecisionBase,
  IntervalUnit,
  KeySnapshot,
  Limiter,
  LimiterOptions,
  LimiterStats,
  RateConstraint,
  RefusalReason,
  RetryPolicy,
  RunOptions,
  SaturationKind,
  Verdict,
} from './types.js';

export type {CancelTimer, Clock} from './time.js';
export {realClock} from './time.js';

export type {RandomFn} from './random.js';
export {createSeededRandom} from './random.js';

export {
  QuotaPilotAbortError,
  QuotaPilotBudgetError,
  QuotaPilotConfigError,
  QuotaPilotError,
  QuotaPilotKeyLimitError,
  QuotaPilotQueueFullError,
  QuotaPilotSaturatedError,
  QuotaPilotTimeoutError,
} from './errors.js';
export type {QuotaPilotErrorDetails} from './errors.js';
