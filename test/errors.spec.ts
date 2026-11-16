import {describe, expect, it} from 'vitest';

import {
  LimiterAbortError,
  LimiterBudgetError,
  LimiterConfigError,
  LimiterError,
  LimiterKeyLimitError,
  LimiterQueueFullError,
  LimiterSaturatedError,
  LimiterTimeoutError,
} from '../src/errors.js';

describe('error taxonomy', () => {
  it('every refusal is catchable as LimiterError', () => {
    const errors = [
      new LimiterConfigError('x'),
      new LimiterSaturatedError('x', {kind: 'rate', waitMs: 1, binding: 'b'}),
      new LimiterQueueFullError('x'),
      new LimiterKeyLimitError('x'),
      new LimiterBudgetError('x'),
      new LimiterTimeoutError('x', {timeoutMs: 1}),
      new LimiterAbortError(),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(LimiterError);
      expect(error).toBeInstanceOf(Error);
      expect(error.stack).toBeTypeOf('string');
    }
  });

  it('carries an explicit name that a minifier cannot mangle away', () => {
    expect(new LimiterConfigError('x').name).toBe('LimiterConfigError');
    expect(new LimiterBudgetError('x').name).toBe('LimiterBudgetError');
    expect(new LimiterQueueFullError('x').name).toBe('LimiterQueueFullError');
    expect(new LimiterKeyLimitError('x').name).toBe('LimiterKeyLimitError');
    expect(new LimiterSaturatedError('x', {kind: 'rate', waitMs: 1, binding: 'b'}).name).toBe(
      'LimiterSaturatedError'
    );
    expect(new LimiterTimeoutError('x', {timeoutMs: 1}).name).toBe('LimiterTimeoutError');
  });

  it("names the abort error 'AbortError' for fetch interoperability", () => {
    // Deliberately NOT the class name: callers already branch on this string.
    const error = new LimiterAbortError();
    expect(error.name).toBe('AbortError');
    expect(error).toBeInstanceOf(LimiterError);
  });

  it('records context when it is known and leaves it undefined otherwise', () => {
    const withContext = new LimiterBudgetError('deadline', {
      key: 'acct-1',
      attempt: 3,
      elapsedMs: 1_234,
    });
    expect(withContext.key).toBe('acct-1');
    expect(withContext.attempt).toBe(3);
    expect(withContext.elapsedMs).toBe(1_234);

    const bare = new LimiterConfigError('bad config');
    expect(bare.key).toBeUndefined();
    expect(bare.attempt).toBeUndefined();
    expect(bare.elapsedMs).toBeUndefined();
  });

  it('preserves the caller error as `cause` when one exists', () => {
    const underlying = new Error('socket hang up');
    const refusal = new LimiterBudgetError('out of budget', {cause: underlying});
    expect(refusal.cause).toBe(underlying);
  });

  it('omits `cause` entirely when none was supplied', () => {
    expect('cause' in new LimiterConfigError('x')).toBe(false);
  });

  it('exposes the saturation detail a caller needs to decide what to do', () => {
    const error = new LimiterSaturatedError('no capacity', {
      kind: 'rate',
      waitMs: 450,
      binding: 'per-second',
      key: 'k',
    });
    expect(error.kind).toBe('rate');
    expect(error.waitMs).toBe(450);
    expect(error.binding).toBe('per-second');
  });

  it('carries a kind that discriminates independently of the binding label', () => {
    // `binding` is a human-readable label and, for the concurrency kinds, names
    // an OPTION — which a caller could in principle also name a constraint
    // after. `kind` is the reliable discriminator, which is why the
    // constructor requires it rather than inferring it.
    const collision = new LimiterSaturatedError('x', {
      kind: 'concurrency',
      waitMs: 0,
      binding: 'maxConcurrent',
    });
    expect(collision.kind).toBe('concurrency');

    const ratedSameLabel = new LimiterSaturatedError('x', {
      kind: 'rate',
      waitMs: 10,
      binding: 'maxConcurrent',
    });
    expect(ratedSameLabel.kind).toBe('rate');
    expect(ratedSameLabel.binding).toBe(collision.binding);
  });

  it('carries no cause on a timeout, because the attempt produced no error', () => {
    const error = new LimiterTimeoutError('attempt timed out', {timeoutMs: 20_000});
    expect(error.timeoutMs).toBe(20_000);
    expect('cause' in error).toBe(false);
  });
});
