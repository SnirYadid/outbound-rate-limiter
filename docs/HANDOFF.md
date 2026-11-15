# Handoff — end of Day 2 (M2)

Repo: `~/WebstormProjects/quotapilot`, standalone, outside any other checkout.
Nothing from any other codebase is in it.

Commits (local only, **nothing pushed, nothing published**):

```
f7b87ca  Day 2 (M2): keyed partitioning, concurrency and queueing
15dae93  Day 1 (M1): foundation layer
```

Version bumped to `0.1.0-alpha.1` — the package content changed and nothing was
ever published, so there is no conflict.

---

## 1. What was implemented

`createLimiter` works. A call with capacity runs; a call without it queues and
runs when capacity arrives.

| Module | Role |
|---|---|
| `src/partition.ts` | Per-key state (buckets, queue, in-flight, pump flags) and the registry that owns it: creation, `maxKeys`, the eviction sweep, `isDisposable` |
| `src/semaphore.ts` | Counting semaphore, synchronous `tryAcquire`, FIFO waiter list |
| `src/queue.ts` | `BoundedFifo` — refuses at its bound rather than growing |
| `src/admit.ts` | The synchronous all-or-nothing check-and-consume across every constraint |
| `src/scheduler.ts` | The per-key pump: admit what you can, stop, record what you are waiting for |
| `src/limiter.ts` | `createLimiter` — wiring, option validation, the task lifecycle |

New public surface: `createLimiter`, and the types `Limiter`, `LimiterOptions`,
`RunOptions`, `AttemptContext`, `LimiterStats`. New options: `maxConcurrent`,
`maxConcurrentPerKey`, `maxQueueDepth`, `maxKeys`, `sweepIntervalMs`, `clock`.

**Interface changes from the approved sketch**, all in `CHANGELOG.md`:

1. `LimiterOptions.clock?: Clock` replaces separate `now` and `setTimer`
   functions. `Clock` was already exported, two loose functions duplicated it,
   and overriding one without the other was a footgun.
2. `run`'s task may return `T | Promise<T>`, not only `Promise<T>`. Widening,
   so non-breaking.
3. `sweepIntervalMs` is new. It is a genuine operator knob and it is what lets
   the differential eviction test exercise production behaviour rather than a
   test-only hook.
4. `AttemptContext` ships `{key, elapsedMs}` only. `attempt` arrives with
   retries (Day 4), `signal` with cancellation (Day 5). Both additive.

---

## 2. Architecture decisions

Full text in `docs/DECISIONS.md` (D19–D28). The three that carry the weight:

**Rate state is per key and never shared (D19).** Within one key, capacity only
grows with time, because no other key can take it. That is why the pump never
re-checks rate capacity after waiting for a concurrency slot, and therefore why
admission needs no retry loop and cannot spin. Remove the isolation and that
reasoning collapses.

**Synchronous admission (D20, D21).** The semaphore's `tryAcquire` returns
`null` on refusal instead of a promise, so admission checks per-key
concurrency, then rate, then a slot, then commits — all in one synchronous
block. Check order is cheapest-and-least-destructive first, so a refusal never
has to undo anything. Rate before slot specifically, so a rate-saturated key
cannot sit on concurrency it cannot use. The commit cannot fail, because the
peek and the acquire share one turn.

**Eviction only when provably full (D25).** A bucket at capacity carries no
information, so dropping it is indistinguishable from keeping it. The sweep
interval defaults to the longest refill-from-empty time — the soonest a drained
partition could become disposable — and a sweep is forced when the registry is
full, because turning a caller away while disposable keys sit in the map is a
missed cleanup rather than a limit.

**Cross-key fairness, now stated precisely (D22):** no ordering guarantee
*between* keys; each progresses independently. Where keys compete — the global
cap — slots go out in the order keys became capacity-eligible, via the
semaphore's FIFO waiters. A busy key cannot starve a quiet one.

**Wake-up discipline (D23, D24):** every stop has exactly one matching wake —
a timer for rate, the semaphore list for a slot, a call's own completion for
per-key concurrency, the next enqueue when idle. No polling, no tick. Lost
wake-ups are prevented structurally: the stop and the registration share one
synchronous turn, so nothing can slip between them on a single-threaded loop.

---

## 3. Test results (measured)

```
npm run verify   →  typecheck + test + build + smoke, all green
```

| Check | Result |
|---|---|
| `npm run typecheck` | clean, strict |
| `npm test` | **186 passed / 186**, 12 files, ~1 s |
| Coverage | **100%** statements / branches / functions / lines, every runtime module |
| `npm run build` | dual ESM + CJS + `.d.ts`, `tsc` only |
| `npm run smoke` | **PASS** — now drives `createLimiter` on a real clock from ESM, CJS and TypeScript fixtures |
| Runtime dependencies | zero, enforced by a test |

Mandatory coverage, all present: partition isolation (3 tests), per-key FIFO (3),
global concurrency (2), per-key concurrency (2), synchronous failures (3),
rejected async tasks (3), queue saturation (4), safe eviction (9), registry
exhaustion (3), wake-up behaviour (5), liveness (2 + a property), capacity
conservation (a property).

**Differential eviction test:** eight seeded schedules (seeds 1, 2, 3, 7, 11,
23, 101, 1013), 60 arrivals each over 6 keys with mixed costs, replayed with
`sweepIntervalMs: 0` and with eviction fully disabled. Byte-identical admission
timelines in every case. Two guard tests sit beside it: one proving eviction
actually happens during the eviction run (so the comparison is not vacuous),
one proving mid-flight partitions survive aggressive sweeping.

**Four properties** via fast-check, 60 runs each: conservation (per key, per
constraint, over every window), concurrency caps, liveness, isolation.

---

## 4. Invariants verified

| | Invariant | Where |
|---|---|---|
| S1 | Per-key FIFO order | `limiter.spec.ts` |
| S2 | One pump per partition | `pumping` flag; exercised by the sync-failure recursion test |
| S3 | `inflight` within both caps | property P-B |
| S4 | **Admission contains no `await`** | `hygiene.spec.ts`, asserted on `admit.ts` and on `bucket/semaphore/queue` |
| S5 | Failed admission consumes nothing | `semaphore.spec.ts` + admission order |
| S6 | Slot released exactly once | `semaphore.spec.ts` double-release tests |
| S8 | Queue bounded per key | `limiter.spec.ts` saturation group |
| P1 | Never evict queued / running / sleeping partitions | `eviction.spec.ts` |
| P2 | Evict only when every bucket is full | `eviction.spec.ts` + differential |
| P3 | `maxKeys` refuses, never discards owed capacity | `limiter.spec.ts` exhaustion group |
| P4 | New partitions start full | `eviction.spec.ts` |
| Q1–Q9 | Queueing, fairness, concurrency | `docs/GUARANTEES.md`, tested across the suite |
| G2 | Conservation survives the queue and the semaphore | property P-A |

---

## 5. Known limitations

1. **Bounded recursion on synchronous failures (D27).** Capacity is committed
   in the same turn the task is invoked, which is the Day 1 contract. So a task
   that throws synchronously re-pumps from inside its own stack frame, and a
   chain of synchronous failures across N keys nests N deep. Tested at 250
   keys; fine. The fix, if it ever bites, is a trampoline in `finish` — not
   taken now because it would contradict a documented contract for a problem
   nobody has hit.
2. **`stats()` iterates the partition map.** O(keys) per call, 10 000 keys
   worst case. It is for operators and tests, never on the admission path, and
   a derived counter is one more thing that can drift from the truth.
3. **`BoundedFifo.dequeue` is `Array.shift`**, O(n). Irrelevant at the default
   bound of 1024; a ring buffer would be an optimisation with no measurement
   behind it.
4. **No `drain()` yet**, so there is no supported way to wait for a quiet exit.
   Day 5.
5. **Rate-blocked waits are not coalesced across keys.** Each key holds its own
   timer, so N rate-blocked keys means N pending timers. Correct, but a fleet of
   thousands of simultaneously-blocked keys would hold thousands of timers.
6. **ESLint is still not set up.** The determinism, zero-dependency,
   no-console, public-surface and no-`await`-in-admission rules are all enforced
   as tests, but module-layering (`import/no-cycle`) is not. Day 6.

---

## 6. Remaining risks

| Risk | Assessment |
|---|---|
| **Day 3 has less left than planned** | Day 2 necessarily contains a working synchronous admission step — a queue has nothing to wait on without one. Day 3 extends `admit.ts` rather than writing it: per-call cost validation against every constraint, `onSaturated: 'reject'`, the binding constraint's name on refusals, and `inspect()`. Flagged in D28 so this is a known scope shift, not a silent one. |
| **Cancellation will add a second `finish` path (Day 5)** | The double-settle guard in `limiter.ts` exists for exactly this and is currently unreachable, marked with a coverage ignore and a comment saying why. Day 5 must cover it. |
| **Retry re-entering the queue (Day 4)** | D10 says a retry goes to the back of its key's queue. That means `start` must be re-callable for the same logical call, which the current `QueuedCall` shape does not express — it carries a single `start` closure. Day 4 will need to restructure that closure, and should expect it. |
| **Timer coalescing** | Limitation 5 is the one that could need a design change rather than an optimisation. Not urgent; worth a measurement before acting. |

---

## 7. Readiness for Day 3

Ready. Day 3's scope, per the approved plan and narrowed by D28:

- Extend `src/admit.ts`: report the **binding constraint's name** on a rate
  refusal (the outcome currently carries only `waitMs`), and thread it into
  `QuotaPilotSaturatedError`.
- `onSaturated: 'reject'` on `RunOptions` — refuse on the first failed
  admission check instead of queueing, carrying `waitMs` and `binding`.
- `inspect(key?)`: side-effect-free capacity snapshots. `peek` is already pure
  and `msUntilFull` already exists, so this is a projection, not new logic. The
  invariant to test is that calling it changes no admission timeline.
- Per-call cost edge cases beyond the existing `assertCostAdmissible`.

The no-`await` invariant is already enforced by a test, so Day 3 inherits the
proof rather than having to establish it. `peek` already returns the refilled
state so admission refills once and writes once; keep it that way.

**Do not** start retries, timeouts, cancellation or telemetry — Days 4 and 5.
