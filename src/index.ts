/**
 * QuotaPilot — outbound API rate limiting, scheduling and retries for Node.
 *
 * This release (0.1.0-alpha) is the foundation layer only: the weighted token
 * bucket, constraint validation, the clock and randomness seams, and the error
 * taxonomy. `createLimiter` and the retry engine are not here yet.
 *
 * Nothing exported below is expected to change shape when they arrive. The
 * types and behaviour that are NOT yet settled are deliberately unexported,
 * so this surface is a promise the release can actually keep.
 *
 * Scope, stated once here and again on the first screen of the README:
 * QuotaPilot bounds outbound traffic from ONE Node process. Run N instances
 * and your real ceiling is N times what you configured.
 */

export const VERSION = '0.1.0-alpha.0';

export type {IntervalUnit, RateConstraint} from './types.js';

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
