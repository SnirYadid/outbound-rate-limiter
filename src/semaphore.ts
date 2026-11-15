/**
 * A counting semaphore with FIFO waiters.
 *
 * Two properties earn their keep here.
 *
 * `tryAcquire` is SYNCHRONOUS and returns `null` rather than awaiting. That is
 * what lets admission check rate capacity and a concurrency slot in one
 * synchronous block: if either is unavailable, nothing has been taken. An
 * `acquire(): Promise<Release>` API would force an `await` into the middle of
 * admission, which is exactly the rework Day 3 must not need.
 *
 * Waiters are woken in FIFO order, which is what makes cross-key fairness a
 * statement rather than a hope. When slots are scarce, keys are served in the
 * order their heads became capacity-eligible, so no key can be starved by a
 * busier neighbour.
 */

/** Returns a held slot. Idempotent: a second call does nothing. */
export type Release = () => void;

export interface Semaphore {
  /** Takes a slot if one is free. Returns `null` without side effects otherwise. */
  tryAcquire(): Release | null;
  /**
   * Registers a one-shot callback for when a slot may have freed.
   *
   * Call this synchronously after a failed `tryAcquire`, in the same turn: the
   * single-threaded event loop then guarantees no release can have slipped
   * between the two, which is how lost wake-ups are avoided without a lock.
   *
   * The callback is invoked synchronously from `release`. It may find the slot
   * already taken by an earlier waiter and must tolerate that — a spurious
   * wake is always safe.
   */
  waitForRelease(callback: () => void): void;
  /** Slots currently held. */
  readonly inFlight: number;
  /** Registered waiters. */
  readonly waiting: number;
  readonly capacity: number;
}

export function createSemaphore(capacity: number): Semaphore {
  let inFlight = 0;
  const waiters: (() => void)[] = [];
  // Guards against a waiter's own release re-entering the drain loop and
  // reordering the queue underneath it. The outer loop picks up the freed slot
  // on its next pass, so nothing is lost by returning early.
  let draining = false;

  const drain = (): void => {
    if (draining) return;
    draining = true;
    try {
      while (inFlight < capacity && waiters.length > 0) {
        const waiter = waiters.shift();
        /* c8 ignore next */
        if (waiter === undefined) break;
        waiter();
      }
    } finally {
      draining = false;
    }
  };

  return {
    tryAcquire: () => {
      if (inFlight >= capacity) return null;
      inFlight++;
      let released = false;
      return () => {
        // Releasing twice would inflate capacity, which is the one mistake a
        // semaphore must not make. The flag lives in this closure so each
        // handle can only ever give back the slot it took.
        if (released) return;
        released = true;
        inFlight--;
        drain();
      };
    },

    waitForRelease: (callback) => {
      waiters.push(callback);
    },

    get inFlight() {
      return inFlight;
    },
    get waiting() {
      return waiters.length;
    },
    get capacity() {
      return capacity;
    },
  };
}
