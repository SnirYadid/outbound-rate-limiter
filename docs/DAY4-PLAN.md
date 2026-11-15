# Day 4 plan — retries, grounded in the current implementation

Analysis only. No retry code exists, and none should until this is agreed.

The brief for Day 4 is: a failed attempt may be retried, and a retry re-enters
the **back of its key's queue** (D10). The question this document answers is
what the smallest honest restructuring is, and which races it has to close.

---

## What the code looks like today

`run()` builds one object and hands it to the queue:

```ts
interface QueuedCall {
  readonly cost: number;
  readonly enqueuedAt: number;
  readonly start: (release: Release) => void;   // ONE shot
}
```

`start` closes over `fn`, `resolve`, `reject`, `key`, `enqueuedAt` and
`partition`. It invokes `fn`, and whatever happens it settles the outer
promise. The pump's contract is narrow and worth preserving: *peek the head,
admit it, `inflight++`, call `start`, move on*.

So one `QueuedCall` is currently **both** the logical call and its single
attempt. Retries need those separated.

---

## The five states a retrying call passes through

Today there are two (`queued`, `inflight`). Retries add a third, and it is the
one that causes the trouble.

| State | Holds a queue slot? | Holds a concurrency slot? | Counted by `stats()`? |
|---|---|---|---|
| queued | yes | no | `queued` |
| in flight | no | **yes** | `inflight` |
| **backing off** | **no** | **no** | **nothing** ← the problem |
| re-queued | yes | no | `queued` |
| settled | no | no | nothing |

"Backing off" must not hold a concurrency slot: a call that is sleeping is not
doing work, and holding a slot through a backoff would let one retrying call
block the whole limiter for the length of its delay. But the moment it holds
nothing, it becomes invisible — and three things break.

---

## The three problems, in priority order

### P1 (critical) — a backing-off call can have its partition evicted underneath it

`isDisposable` returns true when: the queue is empty, `inflight === 0`, no wake
timer, and every bucket is full. **A call in backoff satisfies all four**, and a
backoff long enough for the bucket to refill makes the last one true too.

The failure is worse than handing out free capacity. The call holds a direct
reference to its `Partition` object through the closure, so after eviction:

1. The registry deletes the map entry.
2. The backoff fires and re-enqueues into the **orphaned** `Partition`.
3. A fresh `run()` for the same key calls `acquire`, which mints a **new,
   full** partition and puts it in the map.
4. Two partitions now exist for one key, each enforcing the limit
   independently — so the effective rate limit is doubled, silently, and only
   for keys that happened to retry.

**Fix, minimal:** give `Partition` a `backingOff: number` counter, increment it
for the duration of each backoff, and add `if (partition.backingOff > 0) return
false` to `isDisposable`. That restores P1's real meaning — "never evict a
partition with outstanding work" — which the current implementation expresses
as three separate checks that happen to be exhaustive only because backoff does
not exist yet.

Expose it on `stats()` too, otherwise the counters silently stop adding up.

### P2 (correctness) — the double-settle guard is per-attempt, not per-call

`let settled = false` is declared **inside** `start`, so every invocation gets a
fresh flag. That is correct today (one attempt per call) and wrong the moment
there are two: attempt 1 can resolve late, after attempt 2 has started, and
settle the outer promise with a value the caller was never supposed to see —
or worse, settle it twice and have the second settle silently ignored while
`inflight` is decremented twice.

**Fix, minimal:** move `settled` onto the call object so it spans every attempt.
The existing `/* c8 ignore */` guard in `limiter.ts` is already annotated as
existing for exactly this; Day 4 makes it reachable and must cover it.

Note the slot bookkeeping must stay **per attempt** even though settlement
becomes per call — each attempt acquires and releases its own slot. Conflating
the two is the easy mistake here.

### P3 (bookkeeping) — budget and attempt counting need two checkpoints

`totalBudgetMs` runs from `run()` entry and includes queue time (D10). So it has
to be checked in two places:

- before scheduling a backoff (no point sleeping past the deadline), and
- at admission, because the budget can expire while the call sits re-queued.

And `attempts` must increment when an attempt **starts**, not when the call is
enqueued — a call that is re-queued and then refused for budget never ran, and
must not be reported as having used an attempt.

---

## The minimal shape

```ts
interface QueuedCall {
  readonly cost: number;
  /** First enqueue. The origin for totalBudgetMs. */
  readonly enqueuedAt: number;
  /** Attempts STARTED. Incremented by the pump path, not by enqueueing. */
  attempts: number;
  /** Spans every attempt, so a late settle from attempt N cannot win. */
  settled: boolean;
  /** Starts one attempt. Never throws. Decides settle-vs-requeue itself. */
  runAttempt: (release: Release) => void;
}
```

Plus `backingOff: number` on `Partition`, one clause in `isDisposable`, and one
field on `LimiterStats`.

**The scheduler does not change.** `pump` still peeks, admits, counts in and
starts. That is the point of putting the retry decision in `limiter.ts`, which
already owns `fn`, the policy and the promise: the scheduler stays "admit the
head of this queue" and gains no knowledge of retries at all.

Re-enqueueing is `partition.queue.enqueue(call)` followed by `pump(partition,
context)` — the same two calls `run()` already makes. A full queue at re-enqueue
time is an edge case needing a decision: rejecting a call that already ran once
is harsh, so the better answer is probably to let a retry bypass
`maxQueueDepth`, since the call is already accounted for. Worth deciding
explicitly rather than inheriting whatever falls out.

---

## Races and transitions to test

1. Partition eviction during backoff (P1) — the differential eviction test
   should be extended to schedules that include retries.
2. Late settle from a superseded attempt (P2).
3. Budget expiring *while* re-queued, not just before the backoff.
4. Abort during backoff (Day 5) — the backoff timer must be cancellable, which
   means it must be tracked somewhere reachable, like `wakeTimer` is.
5. `drain()` (Day 5) must wait for backing-off calls, which is the second
   reason the counter has to exist.
6. A retry re-entering a queue that filled up while it was sleeping.
7. Synchronous throw on attempt 2 — the recursion bound from D27 applies per
   attempt, so a retry storm deepens the stack further than Day 2 measured.

---

## What Day 4 should NOT do

Not a queue refactor. `BoundedFifo` is adequate; re-enqueue is just another
`enqueue`. Not a scheduler change. Not a new abstraction for "attempt" as a
first-class object — three mutable fields on the existing call object cover
every requirement above, and anything larger is speculative until cancellation
and telemetry land and show what they actually need.
