/**
 * QuotaPilot — outbound API rate limiting, scheduling and retries for Node.
 *
 * This release (0.1.0-alpha) covers constraints, keyed partitioning with safe
 * eviction, global and per-key concurrency, and bounded per-key FIFO queueing.
 * Retries, per-attempt timeouts, cancellation and telemetry events are not
 * here yet; each is an additive change to the surface below.
 *
 * Types describing behaviour that is NOT yet implemented are deliberately
 * unexported, so this surface is a promise the release can actually keep.
 *
 * Scope, stated once here and again on the first screen of the README:
 * QuotaPilot bounds outbound traffic from ONE Node process. Run N instances
 * and your real ceiling is N times what you configured.
 */

export const VERSION = '0.1.0-alpha.3';

export {createLimiter} from './limiter.js';
export type {
  AttemptContext,
  ClassifyContext,
  ConstraintSnapshot,
  IntervalUnit,
  KeySnapshot,
  Limiter,
  LimiterOptions,
  LimiterStats,
  RateConstraint,
  RetryPolicy,
  RunOptions,
  SaturationKind,
  Verdict,
} from './types.js';

export type {CancelTimer, Clock} from './time.js';
export {realClock} from './time.js';

export type {RandomFn} from './random.js';
export {createSeededRandom, defaultRandom} from './random.js';

export {
  QuotaPilotAbortError,
  QuotaPilotBudgetError,
  QuotaPilotClosedError,
  QuotaPilotConfigError,
  QuotaPilotError,
  QuotaPilotKeyLimitError,
  QuotaPilotQueueFullError,
  QuotaPilotSaturatedError,
  QuotaPilotTimeoutError,
} from './errors.js';
export type {QuotaPilotErrorDetails} from './errors.js';
