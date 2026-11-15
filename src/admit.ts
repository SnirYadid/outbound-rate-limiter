/**
 * The admission step: check everything, then take everything, in ONE
 * synchronous block.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE INVARIANT THIS FILE EXISTS TO HOLD (S4)
 *
 *   `tryAdmit` must contain no `await`, and must call nothing that does.
 *
 * On a single-threaded event loop that makes partial consumption
 * unrepresentable rather than merely tested against: no other code can run
 * between the capacity check and the commit. Introduce one `await` here and
 * two callers can both observe capacity, both commit, and exceed the limit —
 * with no test failing, because the race needs a specific interleaving.
 *
 * A test asserts this file contains no `await`. Do not silence it.
 * ────────────────────────────────────────────────────────────────────────────
 */

import {commit, peek, type BucketState} from './bucket.js';
import type {NormalizedConstraint} from './constraints.js';
import type {Partition} from './partition.js';
import type {Release, Semaphore} from './semaphore.js';

/** Why a call could not start. Each reason has a different thing to wait on. */
export type BlockedBy =
  /** Not enough capacity yet. Resolves with the passage of time. */
  | 'rate'
  /** The global concurrency cap is full. Resolves when some call finishes. */
  | 'slot'
  /** This key's own concurrency cap is full. Resolves when one of ITS calls finishes. */
  | 'key-concurrency';

export type AdmitOutcome =
  | {readonly admitted: true; readonly release: Release}
  | {
      readonly admitted: false;
      readonly blockedBy: 'rate';
      /** Milliseconds until the binding constraint can serve this cost. */
      readonly waitMs: number;
      /**
       * Name of the constraint that bound — the one with the LONGEST wait,
       * since that is the one actually being waited on. Ties go to declaration
       * order, which the caller controls and can reason about.
       */
      readonly binding: string;
    }
  | {
      readonly admitted: false;
      readonly blockedBy: 'slot' | 'key-concurrency';
    };

export interface AdmitContext {
  readonly constraints: readonly NormalizedConstraint[];
  readonly semaphore: Semaphore;
  readonly maxConcurrentPerKey: number;
}

/**
 * Attempts to start one call of `cost` units on `partition`.
 *
 * All-or-nothing. On success, every constraint has been debited and a
 * concurrency slot is held. On failure, NOTHING has been taken: no capacity,
 * no slot (S5).
 *
 * The check order is deliberate — cheapest and least destructive first, so a
 * refusal never has to undo anything:
 *
 *   1. per-key concurrency  (a counter read)
 *   2. rate capacity        (pure `peek`, writes nothing)
 *   3. global slot          (the only step with a side effect)
 *   4. commit               (cannot fail; see below)
 *
 * Step 4 cannot fail because steps 2 and 3 share one synchronous turn, so the
 * clock has not moved and no other key could have touched these buckets —
 * buckets are per-key, and within a key capacity only grows with time.
 */
export function tryAdmit(
  partition: Partition,
  cost: number,
  now: number,
  context: AdmitContext
): AdmitOutcome {
  const {constraints, semaphore, maxConcurrentPerKey} = context;

  if (partition.inflight >= maxConcurrentPerKey) {
    return {admitted: false, blockedBy: 'key-concurrency'};
  }

  // Peek every constraint before taking anything. `refilled` is carried
  // forward so the commit below refills once rather than twice.
  const refilled: BucketState[] = [];
  let blocking: {readonly name: string; readonly waitMs: number} | undefined;

  for (let index = 0; index < constraints.length; index++) {
    // Index-parallel by construction: `partition.buckets` is built by mapping
    // over this exact constraint list (see createPartitionRegistry), and
    // neither array is ever resized. Asserting that is honest; a guard here
    // would be a branch no test could ever reach.
    const constraint = constraints[index]!;
    const bucket = partition.buckets[index]!;

    const result = peek(bucket, now, cost, constraint.spec);
    refilled.push(result.refilled);

    // Every constraint must permit the call, so the binding one is whichever
    // makes us wait longest. Strict `>` keeps ties with the earlier-declared
    // constraint, which makes the choice deterministic and explainable.
    // `unsatisfiable` (cost above capacity) cannot reach here: the limiter
    // rejects that synchronously at `run()`.
    if (!result.ok && (blocking === undefined || result.waitMs > blocking.waitMs)) {
      blocking = {name: constraint.name, waitMs: result.waitMs};
    }
  }

  if (blocking !== undefined) {
    // Writing the refilled buckets back is a pure clock advance — it consumes
    // nothing — and it saves re-deriving the same values on the next attempt.
    writeBack(partition, refilled);
    return {
      admitted: false,
      blockedBy: 'rate',
      waitMs: blocking.waitMs,
      binding: blocking.name,
    };
  }

  const release = semaphore.tryAcquire();
  if (release === null) {
    writeBack(partition, refilled);
    return {admitted: false, blockedBy: 'slot'};
  }

  for (let index = 0; index < constraints.length; index++) {
    // Same index-parallel invariant as above.
    partition.buckets[index] = commit(refilled[index]!, cost, constraints[index]!.spec);
  }

  return {admitted: true, release};
}

function writeBack(partition: Partition, refilled: readonly BucketState[]): void {
  for (let index = 0; index < refilled.length; index++) {
    partition.buckets[index] = refilled[index]!;
  }
}
