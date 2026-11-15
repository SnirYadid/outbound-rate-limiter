/**
 * Keyed limiting. Each key holds entirely separate capacity, so one busy
 * account cannot slow another.
 */
import {createLimiter} from 'quota-pilot';

export async function main(): Promise<{a: number; b: number; elapsedMs: number}> {
  const limiter = createLimiter({
    constraints: [{name: 'per-second', limit: 2, interval: 'second'}],
  });

  // Two calls on each of two keys. All four start immediately: the limit is
  // 2 per second PER KEY, not across keys. Were it shared, two of the four
  // would have had to wait out most of a second.
  const startedAt = Date.now();
  await Promise.all([
    limiter.run(() => 'a1', {key: 'account-a'}),
    limiter.run(() => 'a2', {key: 'account-a'}),
    limiter.run(() => 'b1', {key: 'account-b'}),
    limiter.run(() => 'b2', {key: 'account-b'}),
  ]);

  // Both keys are now spent, each having served its own 2. `available` is a
  // live reading rather than a frozen one, so it is already a hair above zero:
  // the bucket refills continuously.
  return {
    a: limiter.inspect('account-a').constraints[0]?.available ?? -1,
    b: limiter.inspect('account-b').constraints[0]?.available ?? -1,
    elapsedMs: Date.now() - startedAt,
  };
}
