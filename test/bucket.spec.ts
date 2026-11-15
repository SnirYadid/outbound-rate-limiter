import {describe, expect, it} from 'vitest';

import {
  type BucketSpec,
  commit,
  createBucket,
  isFull,
  msUntilFull,
  peek,
  refill,
  TOKEN_EPSILON,
} from '../src/bucket.js';

/** 10 per second: capacity 10, one token per 100 ms. */
const perSecond10: BucketSpec = {capacity: 10, ratePerMs: 10 / 1_000};
/** Strict pacing: capacity 1, one token per 100 ms. */
const paced: BucketSpec = {capacity: 1, ratePerMs: 10 / 1_000};
/** A credit model: big burst, slow refill. */
const credits: BucketSpec = {capacity: 4_000, ratePerMs: 60 / 1_000};

describe('createBucket', () => {
  it('starts at full capacity', () => {
    const state = createBucket(1_000, perSecond10);
    expect(state).toEqual({tokens: 10, updatedAt: 1_000});
  });
});

describe('peek', () => {
  it('admits the first call on a fresh bucket', () => {
    const result = peek(createBucket(0, perSecond10), 0, 1, perSecond10);
    expect(result.ok).toBe(true);
    expect(result.waitMs).toBe(0);
    expect(result.available).toBe(10);
  });

  it('admits a cost exactly equal to capacity', () => {
    const result = peek(createBucket(0, perSecond10), 0, 10, perSecond10);
    expect(result.ok).toBe(true);
    expect(result.unsatisfiable).toBe(false);
  });

  it('reports a cost above capacity as unsatisfiable rather than a long wait', () => {
    const result = peek(createBucket(0, perSecond10), 0, 11, perSecond10);
    expect(result.ok).toBe(false);
    expect(result.unsatisfiable).toBe(true);
    expect(result.waitMs).toBe(Infinity);
  });

  it('computes the wait for a drained bucket from the deficit and the rate', () => {
    const drained = {tokens: 0, updatedAt: 0};
    // One token at 10/sec is 100 ms.
    expect(peek(drained, 0, 1, perSecond10).waitMs).toBe(100);
    // Three tokens is 300 ms.
    expect(peek(drained, 0, 3, perSecond10).waitMs).toBe(300);
  });

  it('never returns a zero wait when it refuses', () => {
    // A deficit far below one millisecond of refill still waits a whole tick,
    // because returning 0 would spin the scheduler.
    const nearlyThere = {tokens: 1 - 1e-6, updatedAt: 0};
    const result = peek(nearlyThere, 0, 1, {capacity: 1, ratePerMs: 1e-3});
    expect(result.ok).toBe(false);
    expect(result.waitMs).toBeGreaterThanOrEqual(1);
  });

  it('is pure: repeated peeks on the same state return the same answer', () => {
    const state = {tokens: 4, updatedAt: 0};
    const first = peek(state, 500, 3, perSecond10);
    const second = peek(state, 500, 3, perSecond10);
    const third = peek(state, 500, 3, perSecond10);

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    // And the input is untouched.
    expect(state).toEqual({tokens: 4, updatedAt: 0});
  });

  it('admits at most EPSILON early, and the slack is tiny', () => {
    const state = {tokens: 1 - TOKEN_EPSILON / 2, updatedAt: 0};
    expect(peek(state, 0, 1, paced).ok).toBe(true);
  });
});

describe('refill', () => {
  it('restores tokens in proportion to elapsed time', () => {
    const drained = {tokens: 0, updatedAt: 0};
    expect(refill(drained, 500, perSecond10).tokens).toBeCloseTo(5, 9);
  });

  it('clamps at capacity however long has passed', () => {
    const drained = {tokens: 0, updatedAt: 0};
    expect(refill(drained, 10_000_000, perSecond10).tokens).toBe(10);
  });

  it('returns the identical object when nothing changed', () => {
    const full = createBucket(0, perSecond10);
    expect(refill(full, 0, perSecond10)).toBe(full);
  });

  it('stalls rather than inflating when the clock moves backwards', () => {
    const state = {tokens: 3, updatedAt: 1_000};
    const rewound = refill(state, 400, perSecond10);

    expect(rewound.tokens).toBe(3);
    // `updatedAt` stays ahead, so the bucket waits for real time to catch up.
    expect(rewound.updatedAt).toBe(1_000);
  });

  it('treats a NaN timestamp as zero elapsed, never as a refill', () => {
    const state = {tokens: 2, updatedAt: Number.NaN};
    expect(refill(state, 5_000, perSecond10).tokens).toBe(2);
  });

  it('clamps a hand-constructed state that exceeds capacity', () => {
    const bogus = {tokens: 999, updatedAt: 0};
    expect(refill(bogus, 0, perSecond10).tokens).toBe(10);
  });

  it('resolves an infinite elapsed time to a full bucket, not to NaN', () => {
    const state = {tokens: 0, updatedAt: -Infinity};
    expect(refill(state, 0, perSecond10).tokens).toBe(10);
  });

  it('resolves a NaN token count to empty rather than propagating NaN', () => {
    // Only reachable from a hand-constructed state, but a NaN that survives
    // would make both `tokens >= cost` and `tokens >= capacity` false forever:
    // a bucket that neither admits nor ever reports itself full.
    const bogus = {tokens: Number.NaN, updatedAt: 0};
    expect(refill(bogus, 0, perSecond10).tokens).toBe(0);
  });
});

describe('commit', () => {
  it('subtracts the cost and preserves the refill timestamp', () => {
    const {refilled} = peek(createBucket(0, perSecond10), 300, 4, perSecond10);
    const after = commit(refilled, 4, perSecond10);

    expect(after.tokens).toBe(6);
    expect(after.updatedAt).toBe(300);
  });

  it('never goes negative, even on an EPSILON-early admission', () => {
    const state = {tokens: 1 - TOKEN_EPSILON / 2, updatedAt: 0};
    const {ok, refilled} = peek(state, 0, 1, paced);

    expect(ok).toBe(true);
    expect(commit(refilled, 1, paced).tokens).toBe(0);
  });

  it('weighted costs draw down proportionally', () => {
    let state = createBucket(0, credits);
    for (const cost of [100, 250, 1_000]) {
      const result = peek(state, 0, cost, credits);
      expect(result.ok).toBe(true);
      state = commit(result.refilled, cost, credits);
    }
    expect(state.tokens).toBe(4_000 - 1_350);
  });
});

describe('msUntilFull / isFull', () => {
  it('reports zero for a full bucket', () => {
    const full = createBucket(0, perSecond10);
    expect(msUntilFull(full, 0, perSecond10)).toBe(0);
    expect(isFull(full, 0, perSecond10)).toBe(true);
  });

  it('reports the time to recover the full deficit', () => {
    const drained = {tokens: 0, updatedAt: 0};
    expect(msUntilFull(drained, 0, perSecond10)).toBe(1_000);
    expect(msUntilFull(drained, 400, perSecond10)).toBe(600);
    expect(isFull(drained, 999, perSecond10)).toBe(false);
    expect(isFull(drained, 1_000, perSecond10)).toBe(true);
  });
});

describe('pacing behaviour (burst = 1)', () => {
  it('spaces unit-cost admissions by one token period', () => {
    // 10 per second with burst 1 paces at one per 100 ms.
    let state = createBucket(0, paced);
    const admittedAt: number[] = [];

    for (let now = 0; now <= 500; now += 10) {
      const result = peek(state, now, 1, paced);
      if (result.ok) {
        state = commit(result.refilled, 1, paced);
        admittedAt.push(now);
      }
    }

    expect(admittedAt).toEqual([0, 100, 200, 300, 400, 500]);
  });

  it('does NOT pace strictly once a single cost exceeds one token', () => {
    // The documented limitation. With burst raised to admit cost 3 at all,
    // three units land at the same instant — the overshoot is `burst`, and
    // `burst` can never be below the largest cost.
    const spec: BucketSpec = {capacity: 3, ratePerMs: 10 / 1_000};
    const result = peek(createBucket(0, spec), 0, 3, spec);

    expect(result.ok).toBe(true);
    // Three units consumed with zero elapsed time: not one-per-100ms.
    expect(commit(result.refilled, 3, spec).tokens).toBe(0);
  });
});
