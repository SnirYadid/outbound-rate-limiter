/**
 * A clock that counts how often it is read. Test-only.
 *
 * It exists for one job: making "no telemetry event is built when nobody is
 * watching" observable from outside. Event construction stamps `at` from
 * `clock.now()`, so an event built and then discarded shows up as an extra
 * read. Running the identical schedule twice — once with a listener, once
 * without — and comparing the counts turns an internal optimisation into a
 * property a test can hold the library to.
 */

import type {Clock} from '../../src/time.js';
import {createVirtualClock, type VirtualClock} from './virtual-clock.js';

export interface CountingClock extends VirtualClock {
  /** How many times `now()` has been called. */
  reads(): number;
  /** Resets the counter without disturbing time or pending timers. */
  resetReads(): void;
}

export function createCountingClock(start = 0): CountingClock {
  const inner = createVirtualClock(start);
  let reads = 0;

  const clock: Clock = {
    now: () => {
      reads++;
      return inner.now();
    },
    setTimer: inner.setTimer,
  };

  return {
    ...inner,
    now: clock.now,
    setTimer: clock.setTimer,
    reads: () => reads,
    resetReads: () => {
      reads = 0;
    },
  };
}
