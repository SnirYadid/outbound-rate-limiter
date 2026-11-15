/**
 * Reference classifiers — to COPY, not to import.
 *
 * QuotaPilot's core contains no status codes, no header names and no
 * `Retry-After` parsing, and it never will: a default would be wrong at some
 * provider, silently. These are a starting point you own and adjust.
 */
import type {ClassifyContext, Verdict} from 'quota-pilot';

/**
 * Parses `Retry-After`, which comes in two forms: delay-seconds, or an
 * HTTP-date. Returns milliseconds, or `null` when the header is absent or
 * unparseable — in which case the caller should fall back to ordinary backoff.
 *
 * No upper bound is imposed. A provider that names an hour gets an hour, and
 * QuotaPilot passes a hint through verbatim rather than clamping it. What keeps
 * a call from sleeping that long is `totalTimeoutMs`, which refuses the retry
 * instead of waiting past the deadline.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;

  const trimmed = value.trim();
  if (trimmed === '') return null;

  // Test for the delay-seconds form by SHAPE, not by trying `Number()` and
  // falling through on failure. `Number('-5')` is a perfectly finite -5, and
  // `Date.parse('-5')` then helpfully returns a date in 2001 — so a malformed
  // numeric header would become a 25-year wait. Digits only, and the seconds
  // form cannot be negative anyway.
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;

  // Every date form HTTP allows begins with a day name, so anything that did
  // not match the digits above and does not start with a letter is malformed.
  // Without this guard `Date.parse` accepts '-5' and returns a date in 2001.
  if (!/^[A-Za-z]/.test(trimmed)) return null;

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;
  // A date in the past means "retry now", not a negative wait.
  return Math.max(0, asDate - nowMs);
}

interface ResponseLike {
  readonly status: number;
  readonly headers: {get(name: string): string | null};
}

/**
 * A classifier for an error that carries an HTTP response.
 *
 * The shape worth copying is the ORDER: decide about timeouts first, honour
 * the provider's own wait second, and treat everything unrecognised as
 * permanent rather than retrying it hopefully.
 */
export function httpClassifier(nowMs: () => number) {
  return (error: unknown, context: ClassifyContext): Verdict => {
    // QuotaPilot abandoned this attempt. The server may have completed the
    // work, so repeating it is only safe for an idempotent operation.
    if (context.timedOut) return {retry: false};

    const response = (error as {response?: ResponseLike}).response;
    if (response === undefined) {
      // No response at all: a connection failure. Transient, but only you know
      // whether your operation is safe to repeat.
      return {retry: false};
    }

    if (response.status === 429 || response.status === 503) {
      const hint = parseRetryAfter(response.headers.get('retry-after'), nowMs());
      return hint === null ? {retry: true} : {retry: true, afterMs: hint};
    }
    if (response.status >= 500) return {retry: true};

    // 4xx other than 429: a request the provider will reject again.
    return {retry: false};
  };
}
