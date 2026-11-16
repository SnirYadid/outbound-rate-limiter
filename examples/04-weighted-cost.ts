/**
 * Weighted calls, for providers that price requests in credits.
 *
 * `burst` must be at least your largest `cost`, or that call could never be
 * admitted — the limiter rejects it synchronously rather than waiting forever.
 */
import {createLimiter, LimiterConfigError} from 'outbound-rate-limiter';

export async function main(): Promise<{available: number; refused: boolean}> {
  const limiter = createLimiter({
    // 4000 credits, refilling at 60 per second.
    constraints: [{name: 'credits', limit: 60, interval: 'second', burst: 4_000}],
  });

  await limiter.run(() => 'cheap', {key: 'shop', cost: 1});
  await limiter.run(() => 'expensive', {key: 'shop', cost: 500});

  let refused = false;
  try {
    // Above `burst`: impossible, so it fails at the call site.
    await limiter.run(() => 'absurd', {key: 'shop', cost: 10_000});
  } catch (error) {
    refused = error instanceof LimiterConfigError;
  }

  return {available: limiter.inspect('shop').constraints[0]?.available ?? -1, refused};
}
