/**
 * Every example in `examples/` is executed here and its documented behaviour
 * asserted.
 *
 * The point is not coverage. Documentation that is never run drifts, and a
 * README example that no longer compiles is worse than no example — it costs a
 * reader time and then teaches them something false. These examples are the
 * ones the README quotes verbatim, and they import the package by name
 * (`from 'outbound-rate-limiter'`) exactly as a consumer's code would.
 *
 * These are the only tests that use real time, because the examples are what a
 * consumer actually writes and a consumer does not inject a clock. The delays
 * are a few milliseconds each.
 */

import {describe, expect, it} from 'vitest';

import {main as minimal} from '../examples/01-minimal.js';
import {main as multipleLimits} from '../examples/02-multiple-limits.js';
import {main as keyed} from '../examples/03-keyed.js';
import {main as weighted} from '../examples/04-weighted-cost.js';
import {main as retries} from '../examples/05-retries.js';
import {main as cancellation} from '../examples/06-cancellation-and-budgets.js';
import {main as telemetry} from '../examples/07-telemetry.js';
import {main as drain} from '../examples/08-drain.js';
import {main as globalAndPerKey} from '../examples/09-global-and-per-key.js';
import {main as strictWindow} from '../examples/10-strict-rolling-window.js';
import {httpClassifier, parseRetryAfter} from '../examples/classifiers.js';

describe('examples behave as documented', () => {
  it('01 minimal: six calls against a 5/second limit all resolve', async () => {
    const results = await minimal();

    expect(results).toEqual(['call-0', 'call-1', 'call-2', 'call-3', 'call-4', 'call-5']);
  });

  it('02 multiple limits: the tighter constraint is the one reported as binding', async () => {
    const {constraints, binding} = await multipleLimits();

    expect(constraints).toEqual(['burst', 'sustained']);
    // Six calls against a burst of 5: exactly one had to wait, on 'burst'.
    expect(binding).toEqual(['burst']);
  });

  it('03 keyed: each key has its own capacity', async () => {
    const {a, b, elapsedMs} = await keyed();

    // Four calls against a limit of 2 per second. Had the keys shared one
    // bucket, two of them would have waited ~500ms each. The margin is wide
    // because this is one of the two suites on a real clock and a loaded CI
    // runner is slow; it still fails if the keys ever start sharing capacity.
    expect(elapsedMs).toBeLessThan(400);
    // Both keys spent their 2, leaving a sliver of continuous refill.
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(0.5);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(0.5);
  });

  it('04 weighted cost: costs are debited, and an impossible cost is refused', async () => {
    const {available, refused} = await weighted();

    // 4000 credits less 1 and 500, plus a trickle of refill during the awaits.
    expect(available).toBeGreaterThanOrEqual(3_499);
    expect(available).toBeLessThan(3_501);
    expect(refused).toBe(true);
  });

  it('05 retries: the classifier honours the provider hint and succeeds on the third try', async () => {
    expect(await retries()).toEqual({attempts: 3, result: 'succeeded'});
  });

  it('06 cancellation and budgets: both surface their own error shape', async () => {
    expect(await cancellation()).toEqual({aborted: true, budgeted: true});
  });

  it('07 telemetry: the documented event kinds appear, and the listener is healthy', async () => {
    const {kinds, waits, hookErrors} = await telemetry();

    expect(kinds).toEqual(['admitted', 'completed', 'delayed', 'queued']);
    expect(waits).toEqual(['rate:per-second']);
    expect(hookErrors).toBe(0);
  });

  it('08 drain: it waits for accepted work and does not close the limiter', async () => {
    expect(await drain()).toEqual({before: ['a', 'b', 'c'], after: 'after-drain'});
  });

  it('09 global + per-key: nesting holds the account ceiling across keys', async () => {
    const {attempts, perCredential, maxInAnySecond} = await globalAndPerKey();

    expect(attempts).toBe(18);
    // Work spread evenly across the three credentials.
    expect(perCredential).toEqual({'cred-0': 6, 'cred-1': 6, 'cred-2': 6});
    // The account limiter is declared 6/second with burst 1. G5 bounds any
    // one-interval window at limit + burst = 7. Without the outer limiter the
    // three keys would each run at 3/s, so 9 — which is the whole point.
    expect(maxInAnySecond).toBeLessThanOrEqual(7);
  });

  it('10 strict window: burst 1 removes the clump that causes 429s', async () => {
    const {bursty, paced, burstyFirstSecond, pacedFirstSecond} = await strictWindow();

    expect(bursty).toHaveLength(8);
    expect(paced).toHaveLength(8);

    // Default burst: the first five leave together, before any refill.
    expect(bursty.filter((t) => t < 50)).toHaveLength(5);
    // burst 1: they are spaced, so at most one has left that early.
    expect(paced.filter((t) => t < 50).length).toBeLessThanOrEqual(1);

    // The number a provider with a rolling window actually counts.
    expect(burstyFirstSecond).toBeGreaterThan(pacedFirstSecond);
    expect(pacedFirstSecond).toBeLessThanOrEqual(5);
  });
});

describe('examples/classifiers behaves as documented', () => {
  it('parses Retry-After in its delay-seconds form', () => {
    expect(parseRetryAfter('120', 0)).toBe(120_000);
    expect(parseRetryAfter('0', 0)).toBe(0);
    expect(parseRetryAfter('  30  ', 0)).toBe(30_000);
  });

  it('parses Retry-After in its HTTP-date form, relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:45 GMT', now)).toBe(45_000);
    // A date already in the past means "retry now", not a negative wait.
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now + 10_000)).toBe(0);
  });

  it('returns null for an absent or unparseable header, so backoff takes over', () => {
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter('', 0)).toBeNull();
    expect(parseRetryAfter('soon please', 0)).toBeNull();
  });

  it('rejects a malformed numeric header rather than reading it as a date', () => {
    // The trap this pins: `Date.parse('-5')` is not NaN in V8, it is a date in
    // 2001. A parser that tries `Number()` and falls through to `Date.parse()`
    // turns this header into a multi-year wait.
    expect(Number.isNaN(Date.parse('-5'))).toBe(false);
    expect(parseRetryAfter('-5', 0)).toBeNull();
    expect(parseRetryAfter('1.5', 0)).toBeNull();
  });

  it('declines a timeout, honours a hint, retries 5xx and gives up on other 4xx', () => {
    const classify = httpClassifier(() => 0);
    const headers = (value: string | null) => ({get: () => value});

    const context = {attempt: 1, elapsedMs: 0, timedOut: false};
    const throttled = {response: {status: 429, headers: headers('2')}};
    const unavailable = {response: {status: 503, headers: headers(null)}};
    const serverError = {response: {status: 500, headers: headers(null)}};
    const badRequest = {response: {status: 400, headers: headers(null)}};

    // A timeout is declined whatever the response says.
    expect(classify(throttled, {...context, timedOut: true})).toEqual({retry: false});
    expect(classify(throttled, context)).toEqual({retry: true, afterMs: 2_000});
    expect(classify(unavailable, context)).toEqual({retry: true});
    expect(classify(serverError, context)).toEqual({retry: true});
    expect(classify(badRequest, context)).toEqual({retry: false});
    // No response at all: a connection failure, left to the caller to opt in.
    expect(classify(new Error('ECONNRESET'), context)).toEqual({retry: false});
  });
});
