/**
 * The smallest useful limiter: one limit, one call.
 */
import {createLimiter} from 'quota-pilot';

export async function main(): Promise<string[]> {
  const limiter = createLimiter({
    constraints: [{name: 'per-second', limit: 5, interval: 'second'}],
  });

  // Six calls against a 5-per-second limit. The first five run at once; the
  // sixth waits for capacity rather than failing.
  const results = await Promise.all(
    Array.from({length: 6}, (_, index) => limiter.run(() => `call-${index}`))
  );

  return results;
}
