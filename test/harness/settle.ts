/**
 * Drives a virtual clock until a set of promises has settled. Test-only.
 *
 * `clock.runAll()` alone is not enough for the limiter. It fires the timers
 * that exist when it is called, but a call completing in a later microtask can
 * schedule a NEW timer — and by then nothing is advancing virtual time, so the
 * test hangs on a library that is actually working fine. This alternates
 * microtask flushes with clock advances until everything settles.
 *
 * It also turns a genuine liveness bug into a useful failure. If promises are
 * outstanding and there is no timer to advance and no microtask left to run,
 * the scheduler is stuck — so this throws saying exactly that, instead of
 * letting the test die on a timeout that says nothing.
 */

import type {VirtualClock} from './virtual-clock.js';

const MAX_STEPS = 100_000;

export async function settleAll(
  clock: VirtualClock,
  promises: readonly Promise<unknown>[]
): Promise<void> {
  let outstanding = promises.length;
  const tracked = promises.map((promise) =>
    promise.then(
      () => {
        outstanding--;
      },
      () => {
        outstanding--;
      }
    )
  );

  for (let step = 0; step < MAX_STEPS; step++) {
    await clock.flush();
    if (outstanding === 0) break;

    if (clock.pendingTimers() > 0) {
      await clock.advanceToNextTimer();
      continue;
    }

    // One more flush in case a microtask chain was mid-flight, then conclude.
    await clock.flush();
    if (outstanding === 0) break;

    throw new Error(
      `Scheduler stalled: ${outstanding} of ${promises.length} calls never settled, ` +
        'with no pending timer and no pending microtask. Something is waiting on a ' +
        'wake-up that will never arrive.'
    );
  }

  if (outstanding !== 0) {
    throw new Error(`settleAll exceeded ${MAX_STEPS} steps with ${outstanding} outstanding`);
  }

  await Promise.all(tracked);
}
