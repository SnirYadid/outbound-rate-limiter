/**
 * Retry policy: validation and the backoff arithmetic.
 *
 * Pure. No clock, no promises, no knowledge of HTTP. The one thing this module
 * deliberately does NOT contain is any judgement about which errors deserve a
 * retry — that is the caller's `classify` function, because `429` means a
 * transient throttle at one provider, an exhausted hourly budget at the next,
 * and a permanent entitlement problem at a third (D11).
 */

import {LimiterConfigError} from './errors.js';
import type {RandomFn} from './random.js';
import type {ClassifyContext, RetryPolicy, Verdict} from './types.js';

/** First retry waits this long before jitter. */
export const DEFAULT_BASE_DELAY_MS = 500;
/** Ceiling on the COMPUTED delay. Never applied to a provider's own hint. */
export const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * `2 ** 31` milliseconds is already ~25 days, and the result is clamped by
 * `maxDelayMs` anyway. The cap exists so a pathological `maxAttempts` cannot
 * produce `Infinity` and then `NaN` in the timer math.
 */
const MAX_EXPONENT = 31;

export interface NormalizedRetryPolicy {
  readonly maxAttempts: number;
  readonly classify: (error: unknown, context: ClassifyContext) => Verdict;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter: 'full' | 'none';
  readonly retryOnAttemptTimeout: boolean;
}

export function normalizeRetryPolicy(policy: RetryPolicy): NormalizedRetryPolicy {
  if (typeof policy !== 'object' || policy === null) {
    throw new LimiterConfigError('run() retry must be an object.');
  }

  // Required, and deliberately so: there is no default classifier and there
  // will not be one. A policy without one is a configuration mistake, not an
  // invitation for the library to guess.
  if (typeof policy.classify !== 'function') {
    throw new LimiterConfigError(
      'run() retry.classify is required: it decides which errors are worth retrying. ' +
        'This library ships no default because the same status code means different things ' +
        'at different providers.'
    );
  }

  const maxAttempts = policy.maxAttempts;
  if (
    typeof maxAttempts !== 'number' ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1
  ) {
    throw new LimiterConfigError(
      `run() retry.maxAttempts must be an integer of 1 or more, received ` +
        `${JSON.stringify(maxAttempts)}. 1 means a single attempt and no retries.`
    );
  }

  const jitter = policy.jitter ?? 'full';
  if (jitter !== 'full' && jitter !== 'none') {
    throw new LimiterConfigError(
      `run() retry.jitter must be 'full' or 'none', received ${JSON.stringify(jitter)}.`
    );
  }

  const baseDelayMs = positiveMs(policy.baseDelayMs, DEFAULT_BASE_DELAY_MS, 'retry.baseDelayMs');
  const maxDelayMs = positiveMs(policy.maxDelayMs, DEFAULT_MAX_DELAY_MS, 'retry.maxDelayMs');
  if (maxDelayMs < baseDelayMs) {
    throw new LimiterConfigError(
      `run() retry.maxDelayMs (${maxDelayMs}) must be at least retry.baseDelayMs ` +
        `(${baseDelayMs}).`
    );
  }

  const retryOnAttemptTimeout = policy.retryOnAttemptTimeout ?? false;
  if (typeof retryOnAttemptTimeout !== 'boolean') {
    throw new LimiterConfigError(
      `run() retry.retryOnAttemptTimeout must be a boolean, received ` +
        `${JSON.stringify(retryOnAttemptTimeout)}.`
    );
  }

  return {
    maxAttempts,
    classify: policy.classify,
    baseDelayMs,
    maxDelayMs,
    jitter,
    retryOnAttemptTimeout,
  };
}

/**
 * Delay before the next attempt, given how many have already been made.
 *
 * Exponential from `baseDelayMs`, capped at `maxDelayMs`, then full jitter —
 * a uniform draw from `[0, capped)`. Full jitter rather than a fixed delay
 * because synchronised retries across many callers are how a recovering
 * provider gets knocked over a second time.
 */
export function computeBackoffMs(
  attemptsMade: number,
  policy: NormalizedRetryPolicy,
  random: RandomFn
): number {
  const exponent = Math.min(Math.max(attemptsMade - 1, 0), MAX_EXPONENT);
  const capped = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  if (policy.jitter === 'none') return capped;
  return random() * capped;
}

/**
 * A provider's own wait hint, if it gave a usable one.
 *
 * Returned verbatim: not jittered, and NOT clamped by `maxDelayMs`. Jittering
 * a time the provider named downward earns a second rejection, and clamping it
 * does the same thing more reliably (D9). Only the total budget can override a
 * hint, and then the call is refused rather than sleeping past its deadline.
 *
 * A malformed hint (negative, NaN, Infinity) is ignored rather than trusted,
 * so a parsing bug in a classifier degrades to ordinary backoff instead of
 * scheduling a timer for `NaN` milliseconds.
 */
export function providerHintMs(verdict: Verdict): number | undefined {
  if (!verdict.retry) return undefined;
  const hint = verdict.afterMs;
  if (hint === undefined) return undefined;
  if (typeof hint !== 'number' || !Number.isFinite(hint) || hint < 0) return undefined;
  return hint;
}

function positiveMs(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new LimiterConfigError(
      `run() ${label} must be a finite number greater than 0, received ${JSON.stringify(value)}.`
    );
  }
  return value;
}
