/**
 * Decision telemetry.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE RULE THIS MODULE EXISTS TO HOLD
 *
 *   A listener cannot corrupt the scheduler, and cannot change the result of
 *   a user's task.
 *
 * Four ways a listener could do damage, and how each is closed:
 *
 *   1. It throws. Caught and counted; never propagated into the scheduler,
 *      which would abandon a pump loop mid-queue.
 *   2. It returns a rejected promise (an `async` listener). The rejection is
 *      absorbed and counted. Left alone it would become an unhandled
 *      rejection and could take the process down.
 *   3. It re-enters the limiter and triggers another event synchronously.
 *      Nested emissions are buffered and flushed by the outer call, so a
 *      listener that logs on every event cannot recurse without bound.
 *   4. It mutates the event. Events are frozen, and every field is a
 *      primitive, so there is no nested object to reach through.
 *
 * Events are emitted AFTER the state transition they describe has committed,
 * never during it. A listener therefore always observes consistent state.
 * ────────────────────────────────────────────────────────────────────────────
 */

import type {Decision} from './types.js';

export interface Emitter {
  /** Publishes one event. Never throws. */
  emit(event: Decision): void;
  /** How many listener invocations have failed, synchronously or otherwise. */
  readonly failures: number;
  /** True when a listener was supplied, so callers can skip building events. */
  readonly active: boolean;
}

type Listener = (event: Decision) => void;

export function createEmitter(listener: Listener | undefined): Emitter {
  let failures = 0;

  if (listener === undefined) {
    // No listener: `emit` is a no-op and callers short-circuit on `active`,
    // so telemetry costs nothing when nobody is watching.
    return {
      emit: () => undefined,
      get failures() {
        return 0;
      },
      active: false,
    };
  }

  const pending: Decision[] = [];
  let delivering = false;

  const deliver = (event: Decision): void => {
    try {
      const returned: unknown = listener(event);
      if (isThenable(returned)) {
        // An `async` listener's rejection has nowhere else to go.
        returned.then(undefined, () => {
          failures++;
        });
      }
    } catch {
      failures++;
    }
  };

  return {
    emit: (event) => {
      if (delivering) {
        // Re-entrant: a listener triggered another event. Queue it and let the
        // outer call flush it, so recursion depth stays at one.
        pending.push(event);
        return;
      }
      delivering = true;
      try {
        deliver(event);
        // `deliver` never throws, so this loop always terminates and the
        // buffer always empties.
        while (pending.length > 0) {
          const next = pending.shift();
          /* c8 ignore next -- length was just checked */
          if (next === undefined) break;
          deliver(next);
        }
      } finally {
        delivering = false;
      }
    },
    get failures() {
      return failures;
    },
    active: true,
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as {then?: unknown}).then === 'function'
  );
}

/**
 * Freezes an event before it leaves the library.
 *
 * Every `Decision` field is a primitive by design, so a shallow freeze is a
 * complete one — there is no nested object a listener could reach through and
 * mutate. A test asserts that property, because it is what makes the shallow
 * freeze sufficient.
 */
export function sealEvent<T extends Decision>(event: T): T {
  return Object.freeze(event);
}
