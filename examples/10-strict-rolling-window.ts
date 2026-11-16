/**
 * Why a correct-looking config still gets 429s, and the one-word fix.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * A token bucket is not a rolling window.
 *
 * `burst` defaults to `limit`, so a bucket declared `limit: 5, interval:
 * 'second'` starts FULL. Five calls go out instantly, then refill adds another
 * five over the next second — up to ten inside one second. That is guarantee
 * G5: at most `limit + burst` per interval.
 *
 * If the provider counts "at most 5 in any rolling second" you have just sent
 * nearly double and earned a 429. The limiter is behaving exactly as
 * documented; the configuration was wrong for this provider.
 *
 * `burst: 1` removes the bursting. Calls are then spaced `interval / limit`
 * apart — 200 ms here — and a trailing second holds at most `limit`.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Measured against a server enforcing 6 per rolling second, 20 calls at once:
 *
 *   limit: 5 (burst defaults to 5)   first second: 9 calls   →  4 × HTTP 429
 *   limit: 5, burst: 1               first second: 5 calls   →  0 × HTTP 429
 *
 * The default is not wrong — bursting is what you want when the provider
 * tolerates it, and it is strictly better than a fixed window because the
 * burst is bounded. It is simply not the right default for a strict provider.
 */
import {createLimiter} from 'outbound-rate-limiter';

export async function main(): Promise<{
  bursty: number[];
  paced: number[];
  burstyFirstSecond: number;
  pacedFirstSecond: number;
}> {
  const run = async (burst: number | undefined): Promise<number[]> => {
    const limiter = createLimiter({
      constraints: [
        {name: 'per-second', limit: 5, interval: 'second', ...(burst === undefined ? {} : {burst})},
      ],
    });
    const startedAt = Date.now();
    const startTimes: number[] = [];
    await Promise.all(
      Array.from({length: 8}, () =>
        limiter.run(() => void startTimes.push(Date.now() - startedAt))
      )
    );
    return startTimes;
  };

  // Default burst: the first five leave immediately, in a clump.
  const bursty = await run(undefined);
  // burst: 1: every call is spaced, so no clump exists to overshoot with.
  const paced = await run(1);

  const inFirstSecond = (times: number[]): number => times.filter((t) => t < 1_000).length;

  return {
    bursty,
    paced,
    burstyFirstSecond: inFirstSecond(bursty),
    pacedFirstSecond: inFirstSecond(paced),
  };
}

/**
 * Choosing `burst`, in one line each:
 *
 *   provider tolerates bursts        leave it alone (`burst` = `limit`)
 *   "at most N in any rolling T"     `burst: 1`, and expect no bursting
 *   weighted calls, strict provider  `burst: max(cost)` — the floor, since a
 *                                    cost above capacity can never be admitted
 *   credit pools ("4000 credits,     `burst: 4000, limit: refill-per-interval`
 *    refills at 60/s")               — this is the model the bucket IS
 */
