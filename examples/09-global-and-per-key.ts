/**
 * An account-wide limit AND a per-credential limit, at the same time.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE KEYING BY CREDENTIAL
 *
 * Every constraint you declare is partitioned by `key`. One limiter with
 * `limit: 5` and three keys does not send 5 requests per second — it sends up
 * to 15, because each key holds its own bucket. That is the documented
 * behaviour and it is what makes keys useful, but it is the opposite of what
 * you want when the provider's ceiling is account-wide.
 *
 * A single limiter instance CANNOT express both ceilings. There is no "global"
 * constraint: the key partitions all of them. Two nested limiters can.
 * ────────────────────────────────────────────────────────────────────────────
 */
import {createLimiter} from 'outbound-rate-limiter';

export async function main(): Promise<{
  attempts: number;
  perCredential: Record<string, number>;
  maxInAnySecond: number;
}> {
  // Outer: the account ceiling. Every call shares the default key, so this
  // bucket is genuinely global.
  const account = createLimiter({
    constraints: [{name: 'account', limit: 6, interval: 'second', burst: 1}],
  });

  // Inner: the per-credential ceiling. Keyed, so each credential gets its own.
  const perCredential = createLimiter({
    constraints: [{name: 'credential', limit: 3, interval: 'second', burst: 1}],
  });

  const startedAt = Date.now();
  const startTimes: number[] = [];
  const counts: Record<string, number> = {};

  // Order matters. The per-credential limiter is on the OUTSIDE so a call
  // waiting for its credential's capacity does not occupy a slot in the
  // account limiter's queue. Reverse them and one busy credential can fill
  // the shared queue and stall the others.
  await Promise.all(
    Array.from({length: 18}, (_, index) => {
      const credential = `cred-${index % 3}`;
      return perCredential.run(
        () =>
          account.run(() => {
            startTimes.push(Date.now() - startedAt);
            counts[credential] = (counts[credential] ?? 0) + 1;
            return index;
          }),
        {key: credential}
      );
    })
  );

  // The account ceiling is what the provider actually sees.
  let maxInAnySecond = 0;
  for (const t of startTimes) {
    const inWindow = startTimes.filter((other) => other >= t && other < t + 1_000).length;
    maxInAnySecond = Math.max(maxInAnySecond, inWindow);
  }

  return {attempts: startTimes.length, perCredential: counts, maxInAnySecond};
}

/**
 * WHERE TO PUT THE RETRY POLICY, and why it is not the obvious choice.
 *
 * A retry is a real outbound request. Both ceilings should charge for it, and
 * only one arrangement does. Measured, with a task failing 3 times:
 *
 *   retry on the OUTER limiter (`perCredential.run(..., {retry})`)
 *     physical attempts 3 · per-credential admits 3 · account admits 3   ✓
 *
 *   retry on the INNER limiter (`account.run(..., {retry})`)
 *     physical attempts 3 · per-credential admits 1 · account admits 3   ✗
 *
 * Put it on the OUTER one. Its retry re-runs the whole inner call, so the
 * attempt passes through both buckets. An inner retry loops inside the account
 * limiter and the per-credential bucket never learns about it — so that
 * ceiling silently undercounts by the number of retries, which is exactly the
 * case where you are already in trouble with the provider.
 */
