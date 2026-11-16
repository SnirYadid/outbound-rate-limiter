/**
 * Two limits at once — the common provider shape: a burst allowance and a
 * sustained rate. Both must permit a call before it runs.
 */
import {createLimiter, type Decision} from 'outbound-rate-limiter';

export async function main(): Promise<{constraints: string[]; binding: string[]}> {
  const binding: string[] = [];

  const limiter = createLimiter({
    constraints: [
      {name: 'burst', limit: 5, interval: 'second'},
      {name: 'sustained', limit: 100, interval: 'minute'},
    ],
    // The binding constraint is whichever makes you wait longest. It is named
    // on every delay, so "why is this slow" has an answer in the logs rather
    // than needing a guess.
    //
    // Note that `delayed` reports a WAIT, not a call: a call that is woken,
    // re-checked and still blocked reports again. Count distinct calls by
    // something of your own if that is what you need.
    onDecision: (event: Decision) => {
      if (event.kind === 'delayed') binding.push(event.binding);
    },
  });

  // Six calls against a burst of 5. The sixth has to wait, and `burst` is what
  // it waits on — `sustained` still has 94 of its 100 left.
  await Promise.all(Array.from({length: 6}, (_, index) => limiter.run(() => index)));

  return {
    // Both constraints are reported, in declaration order.
    constraints: limiter.inspect().constraints.map((constraint) => constraint.name),
    binding: [...new Set(binding)],
  };
}
