/**
 * `drain()` — a barrier, not a shutdown.
 *
 * It waits for every call accepted BEFORE the invocation, backoffs included.
 * It does not close the limiter and does not reject new work.
 */
import {createLimiter} from 'outbound-rate-limiter';

export async function main(): Promise<{before: string[]; after: string}> {
  const limiter = createLimiter({
    constraints: [{name: 'per-second', limit: 10, interval: 'second', burst: 2}],
  });

  const before = Promise.all([
    limiter.run(() => 'a', {key: 'acct'}),
    limiter.run(() => 'b', {key: 'acct'}),
    limiter.run(() => 'c', {key: 'acct'}),
  ]);

  await limiter.drain();

  // Still usable: draining is not closing.
  const after = await limiter.run(() => 'after-drain', {key: 'acct'});

  return {before: await before, after};
}
