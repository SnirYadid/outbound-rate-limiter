/**
 * Classified retries.
 *
 * This library ships no default classifier and never will: `429` is a transient
 * throttle at one provider, an exhausted hourly budget at the next and a
 * permanent entitlement problem at a third. Only you know which.
 */
import {createLimiter, createSeededRandom} from 'outbound-rate-limiter';
import type {ClassifyContext, Verdict} from 'outbound-rate-limiter';

/** A synthetic error shaped like an HTTP failure. */
interface HttpLikeError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;
}

function classify(error: unknown, context: ClassifyContext): Verdict {
  // A timeout is not proof of failure: the server may have completed the work.
  if (context.timedOut) return {retry: false};

  const status = (error as HttpLikeError).status;
  if (status === 429) {
    const hint = (error as HttpLikeError).retryAfterMs;
    // A provider's own wait is used verbatim — never jittered, never
    // shortened by maxDelayMs.
    return hint === undefined ? {retry: true} : {retry: true, afterMs: hint};
  }
  if (status !== undefined && status >= 500) return {retry: true};
  return {retry: false};
}

export async function main(): Promise<{attempts: number; result: string}> {
  const limiter = createLimiter({
    constraints: [{name: 'per-second', limit: 50, interval: 'second'}],
    // Seeded so this example is reproducible; omit it in production.
    random: createSeededRandom(1),
  });

  let attempts = 0;
  const result = await limiter.run(
    (ctx) => {
      attempts = ctx.attempt;
      if (ctx.attempt < 3) {
        const error: HttpLikeError = Object.assign(new Error('Too Many Requests'), {
          status: 429,
          retryAfterMs: 5,
        });
        throw error;
      }
      return 'succeeded';
    },
    {
      key: 'acct',
      retry: {maxAttempts: 5, classify},
    }
  );

  return {attempts, result};
}
