/**
 * Cancellation and time budgets.
 *
 * Cancelling before an attempt starts spends no capacity. Cancelling after one
 * starts refunds nothing — the request was sent.
 */
import {createLimiter, QuotaPilotBudgetError} from 'quota-pilot';

export async function main(): Promise<{aborted: boolean; budgeted: boolean}> {
  const limiter = createLimiter({
    constraints: [{name: 'per-second', limit: 50, interval: 'second'}],
  });

  // --- cancellation -------------------------------------------------------
  const controller = new AbortController();
  const cancellable = limiter.run(
    ({signal}) =>
      new Promise<string>((_resolve, reject) => {
        // Thread the signal into whatever you call. QuotaPilot asks your task
        // to stop; it cannot compel it.
        signal.addEventListener('abort', () => {
          reject(signal.reason as Error);
        });
      }),
    {key: 'acct', signal: controller.signal}
  );

  controller.abort();
  let aborted = false;
  try {
    await cancellable;
  } catch (error) {
    // The signal's own reason is rethrown, so this interoperates with fetch.
    aborted = (error as Error).name === 'AbortError';
  }

  // --- total budget -------------------------------------------------------
  // The budget covers queue waits, every attempt and every backoff. It does
  // not interrupt an attempt already running: `attemptTimeoutMs` is the tool
  // for that.
  let budgeted = false;
  try {
    await limiter.run(
      () => {
        throw new Error('always fails');
      },
      {
        key: 'acct',
        totalBudgetMs: 30,
        retry: {
          maxAttempts: 20,
          baseDelayMs: 20,
          maxDelayMs: 20,
          jitter: 'none',
          classify: () => ({retry: true}),
        },
      }
    );
  } catch (error) {
    budgeted = error instanceof QuotaPilotBudgetError;
  }

  return {aborted, budgeted};
}
