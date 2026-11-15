/**
 * Read-only snapshots.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE INVARIANT THIS FILE EXISTS TO HOLD
 *
 *   Calling `inspect()` must never change a future admission outcome, or when
 *   that admission happens.
 *
 * Four things would break it, and each is avoided deliberately:
 *
 *   1. Committing a refill. `refill` RETURNS new state rather than mutating,
 *      so reading the projection is free — as long as nothing writes it back.
 *      Admission writes refills back as an optimisation; inspection must not.
 *   2. Creating a partition. `registry.acquire` creates on miss, and also runs
 *      an eviction sweep and can throw when the registry is full. Inspection
 *      uses `registry.get` and synthesises a hypothetical snapshot on a miss.
 *   3. Touching recency or eviction eligibility. Eviction is decided by
 *      capacity and outstanding work, never by recency, so there is no
 *      last-touched field to disturb — but `acquire`'s sweep would still be a
 *      side effect, which is the other reason for (2).
 *   4. Handing out live state. Every number is copied and both the array and
 *      the objects are frozen, so a caller cannot reach back into a bucket.
 * ────────────────────────────────────────────────────────────────────────────
 */

import {msUntilFull, refill} from './bucket.js';
import type {NormalizedConstraint} from './constraints.js';
import type {PartitionRegistry} from './partition.js';
import type {Clock} from './time.js';
import type {ConstraintSnapshot, KeySnapshot} from './types.js';

export interface InspectContext {
  readonly constraints: readonly NormalizedConstraint[];
  readonly registry: PartitionRegistry;
  readonly clock: Clock;
}

export function inspectKey(key: string, context: InspectContext): KeySnapshot {
  const {constraints, registry, clock} = context;
  const now = clock.now();

  // `get`, never `acquire`: see (2) above.
  const partition = registry.get(key);

  const snapshots: ConstraintSnapshot[] = constraints.map((constraint, index) => {
    if (partition === undefined) {
      // A key the limiter has never seen would start full, so that is the
      // honest projection. `tracked: false` tells the caller it is hypothetical.
      return freezeConstraint({
        name: constraint.name,
        available: constraint.spec.capacity,
        capacity: constraint.spec.capacity,
        msUntilFull: 0,
      });
    }

    // Index-parallel by construction, as in admit.ts.
    const bucket = partition.buckets[index]!;
    // `refill` returns new state; the result is read and discarded. Writing it
    // back here is exactly the mistake this file is built to avoid.
    const projected = refill(bucket, now, constraint.spec);

    return freezeConstraint({
      name: constraint.name,
      available: projected.tokens,
      capacity: constraint.spec.capacity,
      msUntilFull: msUntilFull(bucket, now, constraint.spec),
    });
  });

  return Object.freeze({
    key,
    tracked: partition !== undefined,
    queued: partition?.queue.size ?? 0,
    inflight: partition?.inflight ?? 0,
    waitingForCapacity: partition?.wakeTimer !== undefined,
    constraints: Object.freeze(snapshots),
  });
}

function freezeConstraint(snapshot: ConstraintSnapshot): ConstraintSnapshot {
  return Object.freeze(snapshot);
}
