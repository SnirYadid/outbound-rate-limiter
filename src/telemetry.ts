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
  /**
   * Publishes one event, building it only if somebody is listening.
   *
   * This is the only sanctioned way to emit. `build` is called at most once,
   * never when no listener is attached, and its result is sealed before it is
   * handed out — so a caller cannot forget the gate or the freeze, and
   * `onDecision` costs nothing when nobody is watching.
   *
   * Never throws, whatever the listener does.
   */
  publish(build: () => Decision): void;
  /**
   * Publishes an already-built event. For callers that have one in hand, such
   * as a test driving the emitter directly.
   */
  emit(event: Decision): void;
  /** How many listener invocations have failed, synchronously or otherwise. */
  readonly failures: number;
}

type Listener = (event: Decision) => void;

export function createEmitter(listener: Listener | undefined): Emitter {
  let failures = 0;

  if (listener === undefined) {
    // No listener: nothing is built and nothing is delivered. `publish`
    // discarding its builder unevaluated is what makes telemetry free when
    // nobody is watching.
    return {
      publish: () => undefined,
      emit: () => undefined,
      get failures() {
        return 0;
      },
    };
  }

  const pending: Decision[] = [];
  let delivering = false;

  const deliver = (event: Decision): void => {
    try {
      // The listener's declared return type is `void`, so capturing it looks
      // like a mistake. It is the opposite: an `async` listener returns a
      // promise regardless of what the type says, and this is the only place
      // that promise can be caught before it becomes an unhandled rejection.
      // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression
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

  const emit = (event: Decision): void => {
    // Sealed here, at the single exit, rather than by each caller. Every
    // `Decision` field is a primitive by design, so this shallow freeze is a
    // complete one, and doing it in one place means a new emission site cannot
    // hand out a mutable event by forgetting a step.
    const sealed = sealEvent(event);

    if (delivering) {
      // Re-entrant: a listener triggered another event. Queue it and let the
      // outer call flush it, so recursion depth stays at one. Buffered events
      // are already sealed, so the flush below cannot bypass the freeze.
      pending.push(sealed);
      return;
    }
    delivering = true;
    try {
      deliver(sealed);
      // `deliver` never throws, so this loop always terminates and the
      // buffer always empties.
      while (pending.length > 0) {
        // Non-empty by the loop condition, as in semaphore.ts.
        deliver(pending.shift()!);
      }
    } finally {
      delivering = false;
    }
  };

  return {
    publish: (build) => {
      emit(build());
    },
    emit,
    get failures() {
      return failures;
    },
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
 *
 * Called by `emit`, at the emitter's single exit. Exported because the tests
 * that drive the emitter directly construct their own events.
 */
export function sealEvent<T extends Decision>(event: T): T {
  return Object.freeze(event);
}
