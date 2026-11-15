/**
 * Decision telemetry: why a call waited, retried, started or was refused.
 *
 * Events are frozen, every field is a primitive, and they deliberately carry
 * no error objects or request payloads — your classifier already saw the
 * error, and telemetry should not become a second copy of your request bodies.
 */
import {createLimiter} from 'quota-pilot';
import type {Decision} from 'quota-pilot';

export async function main(): Promise<{
  kinds: string[];
  waits: string[];
  hookErrors: number;
}> {
  const seen: Decision[] = [];
  const waits = new Set<string>();

  const limiter = createLimiter({
    constraints: [{name: 'per-second', limit: 1, interval: 'second', burst: 1}],
    onDecision: (event) => {
      seen.push(event);
      if (event.kind === 'delayed') {
        // `binding` names the rate constraint, or the option for concurrency.
        // In real code this line is your logger.
        //
        // Collected as a SET because `delayed` reports a wait, not a call: a
        // blocked call is woken by every completion ahead of it and reports
        // the same wait again if it is still blocked. How many times that
        // happens depends on machine timing, so count distinct causes.
        waits.add(`${event.cause}:${event.binding}`);
      }
    },
  });

  await limiter.run(() => 'first', {key: 'acct'});
  await limiter.run(() => 'second', {key: 'acct'}); // waits for a token

  return {
    kinds: [...new Set(seen.map((event) => event.kind))].sort(),
    waits: [...waits].sort(),
    // A listener that throws, rejects, or re-enters the limiter cannot change
    // any outcome. Its failures are counted here rather than logged.
    hookErrors: limiter.stats().decisionHookErrors,
  };
}
