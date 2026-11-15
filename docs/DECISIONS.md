# Decisions

One entry per decision that constrains future work. The forward contract for
the milestones that are not built yet, so the next session does not re-litigate
settled ground or quietly contradict it.

Guarantees that follow from these live in `GUARANTEES.md`. This file records
*why*, including the options rejected.

---

## D1 — One rate strategy: the weighted token bucket

Only `strategy: 'bucket'` exists. `RateConstraint.strategy` is present and
validated so adding a second one later is not a breaking change, but no other
value is accepted today.

Rejected for now: clock-aligned fixed windows, and sliding-window logs. The
sliding log is the only thing that gives a strict rolling bound under weighted
costs, and it costs O(limit) memory per key. If a user needs it, the honest
answer today is "QuotaPilot does not do that", not an approximation dressed up
as the real thing.

## D2 — Atomicity by construction, not by lock

The multi-constraint check-and-consume is one synchronous function with no
`await` anywhere inside it, and the call to the user's function happens in the
same turn. On a single-threaded event loop that makes interleaving
unrepresentable.

**This is the load-bearing decision of the whole design.** It is why seven days
is a realistic estimate: the hardest question in the problem space (atomic
multi-key consume) becomes a property of the runtime rather than a protocol to
implement.

The direct consequence: **no `Store` interface, not even an unused one.** An
async store cannot be read and written inside a synchronous critical section,
so adding one is a different admission algorithm — reservation plus
compensation, or a server-side script — not a plug-in. Publishing the interface
now would advertise an extension point that cannot be implemented as drawn.

## D3 — Eviction only when a bucket is provably full

New keys start full, so a bucket at capacity carries no information and
dropping it is observationally identical to keeping it. Eviction is permitted
exactly then, and only when the key has no queued and no in-flight work.

`maxKeys` is enforced by refusing new keys, never by discarding a drained one.
LRU is rejected outright: evicting a partially drained bucket hands out free
capacity.

Verification is a **differential test**, not an assertion — the same arrival
schedule run with eviction forced and with eviction disabled must produce
identical admission timelines. That turns the claim into a proof obligation.

## D4 — A timeout is not proof of failure

`retryOnAttemptTimeout` defaults to `false`. An attempt QuotaPilot itself
aborted is precisely the case where the server may have completed the work, so
retrying it by default would make the library silently unsafe for every
non-idempotent call.

`ClassifyContext.timedOut` lets a caller opt in per-case without the flag.
`QuotaPilotTimeoutError` is its own class, carrying no `cause`, because "the
outcome is unknown" is different information from "the call failed".

## D5 — Concurrency slots are released at the timeout

When an attempt times out, its slot is freed immediately rather than held until
the abandoned promise settles.

The alternative is more faithful — real concurrency would then never exceed the
cap — but one function that never settles would deadlock the limiter
permanently. A misbehaving task should degrade the bound, not stop the world.

The cost is paid in honesty, not in silence: `maxConcurrent` is documented as
bounding *observable* in-flight work (`stats().abandoned` was proposed here and
deliberately never built — see the correction in GUARANTEES.md: nothing could
decrement it), late
completions emit `settled` with `late: true`, and their rejections are
swallowed so an abandoned promise cannot crash the process.

## D6 — Capacity is never refunded

Not on failure, not on timeout, not on cancellation after the attempt started.
The request was sent; it was paid for. There is deliberately no inverse of
`commit`.

Cancellation *before* the attempt starts — queued, or sleeping — consumes
nothing, because nothing was committed yet.

## D7 — Error asymmetry: library refusals are typed, caller errors pass through

If QuotaPilot stopped for a reason of its own (deadline, full queue, key cap,
cancellation, attempt timeout) it throws a `QuotaPilot*` error with `cause` set
to the caller's last error when one exists.

If it ran out of the attempts the caller configured, or the caller's classifier
said stop, **the caller's error surfaces unchanged**. Wrapping it would break
`instanceof` and `.status` checks in caller code, and the attempt count is
already on the telemetry event.

So `e instanceof QuotaPilotError` reads as "the limiter refused".

## D8 — Two retry verdicts, not four

`{retry: true, afterMs?}` and `{retry: false}`. The earlier draft also had
`fail-fast`, which was observationally identical to `stop`, and a separate
"retry on computed backoff" case, which is just `afterMs` omitted.

## D9 — Provider wait hints are used verbatim

`afterMs` is not jittered and not clamped by `maxDelayMs`. Jittering a time the
provider named downward earns a second rejection; clamping it does the same
thing more reliably. Only `totalBudgetMs` overrides a hint, and then the call
refuses rather than sleeping past its deadline.

A caller wanting a safety pad adds it to the number it returns. No option
needed.

## D10 — Every attempt pays, at the back of the queue

A retry re-enters admission and consumes `cost` again. It joins the back of its
key's FIFO queue so a hot retry loop cannot starve fresh work, at the cost of
queue latency on retries — which is visible in the telemetry.

Backoff and the admission wait are **sequential**, not merged: 2 s of backoff
plus a 5 s bucket wait is 7 s. More conservative, and merging would let a retry
storm spend its backoff inside the bucket's own wait.

## D11 — No classification in the core, ever

No status codes, no header names, no `Retry-After` parsing. `classify` is
required when a retry policy is present; a policy without one is a
`QuotaPilotConfigError`.

`429` means a transient throttle at one provider, an exhausted hourly budget at
the next, and a permanent entitlement problem at a third. A default would be
wrong somewhere, silently. Example classifiers ship in `examples/` as code to
copy and own, not to import.

## D12 — Fairness: one FIFO queue and one pump per key

Per key, not per limiter: a single global queue head-of-line-blocks a free key
behind a saturated one. One pump per key means only the head waiter attempts
admission, which removes the thundering herd that sleep-and-retry would create.

Superseded in detail by **D22**, which states the cross-key guarantee precisely
now that it is implemented.

## D13 — Telemetry cannot corrupt the scheduler

Emitted after the commit, never inside it. Events are frozen. The hook is
synchronous, never awaited, and a throw is swallowed and counted in
`stats().decisionHookErrors`. Re-entrant emission is buffered and flushed
afterwards. The library writes nothing to the console.

## D14 — Single process, stated structurally

`scope: 'process'` is a literal on every event. `warnings` is populated at
construction for any window longer than 15 minutes. The README says it above
the install instructions.

**Correction (day 6):** this entry originally promised a `describe()` method
returning an operator-readable block. It was never built, and on review it is
not wanted: `warnings` already carries the configuration problems worth
surfacing, and `scope` on every event carries the fleet-ceiling caveat to the
place an operator actually reads. A third way to say the same thing is surface
without capability.

Stating the limitation is not modesty; it is what makes the remaining
guarantees trustworthy.

## D15 — Timers are not unref'd

An unref'd timer lets Node exit while a caller is still awaiting the promise
behind it, dropping the work silently. `drain()` is the supported route to a
clean exit; a pending timer holding the process open is the honest signal that
work is outstanding.

## D16 — Queue liveness is a mandatory acceptance criterion

The property that every admitted call settles, every queue drains and every
slot is released is **not** available as a scope cut. It is the difference
between a limiter and a hang.

## D17 — Float tokens with an epsilon, not scaled integers

Tolerance is `1e-9` tokens; admission may occur that much early. Integer
micro-tokens were rejected: they relocate the rounding error (the rate still
needs scaling and rounding) and add a conversion at every arithmetic site.

## D18 — Monotonic clock, one time concept

`realClock.now()` is `performance.timeOrigin + performance.now()`: monotonic,
and still comparable to `Date.now()` for log correlation. Using separate
sources for duration math and for event timestamps was considered and rejected
— it doubles the seam for no difference a caller can observe.

Bucket math is independently defensive: a backwards `now` is treated as zero
elapsed, so an injected wall clock stalls rather than inflating.

---

## Open questions, owned by later milestones

- **O1** Should the virtual clock ship as a `quota-pilot/testing` subpath?
  Users can already inject their own `now`/`setTimer`, so the answer is
  probably no. Revisit when someone asks.
- **O2** Does `drain()` need a `{discardQueued: true}` mode, or a separate hard
  `abort()`? Deferred until there is a concrete need.
- **O3** What is the right default for `maxQueueDepth`? 1024 per key is a
  guess. Needs a real workload to calibrate.
- **O4** ~~Lint-enforced layering.~~ **Settled.** Per-layer
  `no-restricted-imports` landed in `eslint.config.js`; cycle detection landed
  as `test/architecture.spec.ts` instead of `import-x/no-cycle`, because that
  rule was proven never to consult its resolver. See docs/ARCHITECTURE.md,
  "Why cycle detection is a test and not a lint rule".

---

# Day 2 decisions

## D19 — Rate state is per key, and that buys more than isolation

Buckets are never shared between keys. The consequence the scheduler leans on:
**within one key, available capacity only ever grows with time.** No other key
can take it.

That is why the pump never re-checks rate capacity after waiting for a
concurrency slot, and therefore why admission needs no retry loop and cannot
spin. Remove the isolation and that reasoning collapses.

## D20 — `tryAcquire`, not `acquire(): Promise`

The semaphore's acquisition is synchronous and returns `null` on refusal. A
promise-returning `acquire` would force an `await` into the middle of
admission, which is precisely the rework Day 3 must not need (D2).

## D21 — Check order: per-key concurrency, rate, slot, commit

Cheapest and least destructive first, so a refusal never has to undo anything.
Only step 3 has a side effect, and if it fails nothing has been consumed.

Rate before slot, specifically: acquiring a slot first would let a
rate-saturated key sit on concurrency it cannot use, starving keys that could.

Step 4 cannot fail, because steps 2 and 3 share one synchronous turn — the
clock has not moved and, by D19, nothing else could have touched these buckets.

## D22 — One FIFO queue and one pump per key

Per key, not per limiter. A single global queue would head-of-line block a free
key behind a saturated one, which is the opposite of what partitioning is for.

**Cross-key fairness, stated precisely:** there is no ordering guarantee
*between* keys; each key progresses independently. Where keys do compete — the
global concurrency cap — slots are handed out in the order keys became
capacity-eligible, via the semaphore's FIFO waiter list. So a busy key cannot
starve a quiet one, and within a key order is strict arrival order.

## D23 — Every stop has exactly one matching wake

The pump admits what it can, then stops and records what it is waiting for:

| Blocked by | Woken by |
|---|---|
| `rate` | a timer set for exactly the wait the bucket reported |
| `slot` | the semaphore's FIFO waiter list |
| `key-concurrency` | completion of one of that key's own calls |
| nothing (queue empty) | the next enqueue |

No polling, no periodic tick, no busy loop. A spurious wake is always safe —
the pump simply re-attempts.

Lost wake-ups are prevented structurally rather than with a lock: the stop and
the registration happen in the SAME synchronous turn as the failed admission,
so on a single-threaded loop nothing can slip between them.

## D24 — At most one wake timer per partition

A second request is a no-op, not a replacement. Only the pump schedules these,
only one pump runs per partition, and a FIFO head cannot change while it is
rate-blocked — so a pending timer is always for the same wait.

## D25 — Eviction is driven by a sweep interval, with a forced sweep when full

The default interval is the longest time any constraint needs to refill from
empty: the soonest a drained partition could possibly become disposable, so
sweeping more often cannot find anything the last sweep missed.

`sweepIntervalMs` is a public option. It is also what makes the differential
eviction test exercise real behaviour rather than a test-only hook.

Being at `maxKeys` forces a sweep regardless of the interval. Turning a caller
away while disposable partitions sit in the map is a missed cleanup, not a
limit.

## D26 — Queue saturation is a rejection, not a throw

`maxQueueDepth` is per key. Exceeding it rejects the returned promise with
`QuotaPilotQueueFullError`, naming the key. It is a rejection rather than a
synchronous throw because by that point the caller holds a promise, and mixing
sync throws with rejections from one call site is worse than either alone.

Configuration errors remain synchronous throws — those are programming
mistakes, not runtime conditions.

## D27 — Capacity is committed in the same turn the task is invoked

There is no `await` between the commit and calling the user's function, which
is the contract Day 1 documented.

**Correction (Day 6).** Day 2 recorded the cost of this as "a chain of
synchronous failures across N keys nests N deep", measured at 250 keys. That
analysis was wrong, and the stress tests written to find its limit found there
is none to find. Stack depth is a **constant 6 frames** — unchanged from 1 key
to 20,000, from 100 calls to 50,000, with and without retries, and with a
telemetry listener submitting new work on every event. The engine's own limit
is around 9,000 frames.

The reason it is flat was already in the code: three reentrancy guards
(`partition.pumping`, the semaphore's `draining`, the emitter's `delivering`)
mean a nested pump returns immediately and the *outer* loop picks the work up.
That makes the pump iterative in effect, whatever it looks like in the source.

So no trampoline is needed and none was added. The microtask-deferral
alternative stays rejected, now for a better reason than "nobody has hit it":
there is nothing to fix. What the stress tests do bound is accepted work in
memory, which is a different question — see "What bounds accepted work" in
GUARANTEES.md.

## D28 — Day 2 necessarily contains a working synchronous admission step

A queue has nothing to wait on without one. `admit.ts` holds the Day 2 subset:
all-or-nothing check-and-consume across every constraint, reporting what
blocked and for how long.

Day 3 EXTENDS it rather than replacing it: per-call cost validation against
every constraint, `onSaturated: 'reject'`, the binding constraint's name on the
outcome for telemetry, and `inspect()`. The no-`await` invariant is already
enforced by a test, so Day 3 inherits the proof rather than having to establish
it.

---

# Day 3 decisions

## D29 — The binding constraint is the one with the longest wait

A refusal names one constraint. When several are out of capacity, the honest
answer is the one that will keep you waiting longest — naming a faster one
sends an operator to tune the wrong knob.

Ties go to **declaration order**. Ties are common rather than exotic (waits are
whole milliseconds), so the rule has to be stated: strict `>` when comparing, so
the earliest-declared constraint wins. Declaration order is something the caller
controls and can reason about, which is what makes the choice explainable rather
than merely deterministic.

## D30 — `QuotaPilotSaturatedError.kind`, and why `binding` is not enough

`binding` is a human-readable label. For `'rate'` it is a declared constraint
name; for the concurrency kinds it names the OPTION responsible
(`maxConcurrent`, `maxConcurrentPerKey`) — and nothing stops a caller naming a
constraint `maxConcurrent`.

So `kind` is the discriminator and is **required** by the constructor: a
construction site cannot forget it. `SaturationKind` is public because callers
branch on it, and each kind clears for a different reason — time, other calls
finishing, or the key's own backlog draining.

## D31 — `onSaturated: 'reject'` refuses when the key has a backlog

Reported as `kind: 'queued-ahead'`.

This is load-bearing, not defensive. A cheap call genuinely can be admissible
while an expensive queued call is not: drain a burst-10 bucket, queue a cost-10
call, wait 300 ms, and a cost-1 call now fits. Admitting it would jump the queue
AND push the expensive call further out. A stream of cheap rejecting callers
would starve it indefinitely.

The alternative — attempt admission and ignore the queue — was rejected for that
reason. `'reject'` therefore means "start now **without reordering anything**,
or fail now". A rejected call is never enqueued, so it holds no capacity, no
slot and no timer, and its promise always settles.

## D32 — `inspect()` reads with `get`, never `acquire`

`registry.acquire` creates on miss, runs an eviction sweep, and can throw
`QuotaPilotKeyLimitError`. All three are side effects, so the read path uses
`registry.get` and synthesises a full-capacity snapshot for an unseen key,
flagged `tracked: false`.

The other half of the invariant: admission writes refilled buckets back as an
optimisation, and inspection must **not**. `refill` returns new state rather
than mutating, so reading the projection is free as long as nothing assigns it
back. A hygiene test asserts `inspect.ts` contains no assignment into
`buckets[...]`, no `commit(`, and no `registry.acquire`.

Proof is differential, like eviction's: identical schedules replayed with and
without inspection at every step must produce identical admission timelines.

Note the distinction the real-clock smoke test made concrete: side-effect-free
does **not** mean static. Projected capacity must track elapsed time, so on a
real clock it grows between two reads. Only the virtual-clock suite can assert
exact equality; the real-clock check asserts capacity is non-decreasing and
never exceeds its ceiling.

## D33 — Index-parallel arrays are asserted, not guarded

`partition.buckets` is built by mapping over the limiter's constraint list and
neither array is ever resized, so `buckets[i]` and `constraints[i]` always
correspond. Under `noUncheckedIndexedAccess` that needs either a guard or an
assertion.

Day 2 used guards, which produced branches no test could reach and therefore two
`/* c8 ignore */` directives. Day 3 replaced them with non-null assertions and a
comment stating the invariant. An ignored branch is an untested branch wearing a
disguise; an assertion is a documented invariant. Net effect: less code, two
fewer coverage exemptions, and the same safety.

## D34 — The `cost` contract was audited, not changed

Established semantics, now pinned by tests rather than by implication: a finite
number greater than zero, no greater than every constraint's `burst`, fractions
allowed, violations throwing **synchronously** from `run()`.

Two findings came out of writing those tests, and both were left as they are:

- **`cost: null` means "use the default"**, because `cost` is defaulted with
  `??` — exactly as `key` is. Rejecting `null` while accepting `undefined` would
  be inconsistent with every other option and would add a restriction the
  contract never had. A TS caller cannot write either (strict optional types),
  so this only concerns untyped JavaScript.
- **The declared `burst` is the real boundary**, not `burst + TOKEN_EPSILON`.
  The bucket's 1e-9 comparison tolerance exists so a float a hair short of the
  cost does not stall forever; it is not an extension of the limit the caller
  declared. A cost above `burst` is refused even within that tolerance.

Also pinned because it reads like a bug and is not one: `10 + Number.EPSILON`
**is** exactly `10` as a double — the spacing between representable values near
10 is about 1.8e-15, roughly eight times `EPSILON` — so that cost is admitted.

---

# Day 4 decisions

## D35 — `backingOff` is the third protection, and the ordering matters

A call sleeping between attempts holds no queue entry and no concurrency slot,
so without a dedicated counter it satisfies every eviction condition. The
consequence is worse than free capacity: the retry re-enters an **orphaned**
partition while a fresh call mints a new, full one, so two partitions enforce
one key's limit independently and the effective limit silently doubles — only
for keys that retried.

Hence `Partition.backingOff`, one clause in `isDisposable`, and one field on
`LimiterStats` so the counters still add up to the work outstanding.

The ordering in `scheduleRetry` is load-bearing: the counter is claimed
**before** the sleep, and on wake the call is **re-queued before** the counter
is dropped. Reversing those two lines reopens the window the counter exists to
close. Proved by a test that reproduces the pre-fix predicate state, and by a
property test asserting conservation survives random retry schedules under
aggressive sweeping.

## D36 — Settlement is tracked at two levels, because they answer two questions

Per **attempt** (`attemptDone`, via `claimAttempt`): who owns this attempt's
outcome. That is what releases the concurrency slot exactly once when a timeout
and a late resolution race.

Per **call** (`settled`): whether the caller's promise has been answered. That
is what stops a straggler from a timed-out attempt overriding a later attempt's
result.

Day 2's `settled` flag lived inside the attempt closure, which was correct when
there was one attempt per call and silently wrong the moment there were two.
Moving it out was the smallest change that fixed it.

## D37 — A queued call needs its own deadline timer

Checking the budget only at admission is not enough. A call behind a long rate
wait would hold its caller well past the budget it asked for, so a queued call
arms a timer for its remaining budget and settles itself when it fires.

Two mechanisms, not one, and both are needed:

- the **timer** makes the refusal prompt, without waiting for admission;
- the pump's **`isExpired` check** makes it impossible for an expired call to
  spend capacity, which matters because capacity is never refunded.

The timer normally wins, so the pump's guard looks redundant — until a rate
wake is already pending and due at the same instant, having been scheduled
earlier. Then the pump runs first and must refuse the admission itself. There
is a test that constructs exactly that race.

The deadline is stood down while an attempt runs (the budget never interrupts
an attempt in flight) and re-armed if the call comes back for another go.

## D38 — A retry bypasses `maxQueueDepth`

`maxQueueDepth` bounds **new intake**. A retrying call was already accepted,
already spent provider capacity, and was promised a number of attempts;
dropping it at the queue door would turn a transient provider failure into a
hard one.

So `BoundedFifo.requeue` appends past the bound. The queue can therefore exceed
`maxQueueDepth` by the number of retrying calls — documented, and visible
through `stats().backingOff`. Total memory stays bounded by the caller's own
concurrency, since every call in the system corresponds to a promise some
caller is holding.

## D39 — `onSaturated` governs the first admission only

Once a call has been admitted and has started, its retries follow the normal
queueing path. `'reject'` means "do not make me wait to **start**"; a caller
who then configures a retry policy has explicitly opted into that policy's
delays, which are waits by definition.

Mixing the two would mean a retry could fail with `QuotaPilotSaturatedError`
instead of retrying, which conflates two different refusal concepts.

## D40 — A throwing classifier means "do not retry", and the real error survives

A classifier that throws is a bug in the caller's code. It must not be able to
invent a different outcome for the call, so the error the operation actually
produced is what surfaces, and no retry happens.

The alternative — surfacing the classifier's own error — was rejected because
it discards the information the caller actually needs.

## D41 — A malformed provider hint is ignored, not trusted

`afterMs` that is negative, `NaN`, `Infinity` or not a number falls back to the
computed backoff. A parsing bug in a classifier should degrade to ordinary
backoff, not schedule a timer for `NaN` milliseconds.

A hint of exactly `0` is honoured as "retry immediately" — that is a legitimate
thing for a provider to say.

## D42 — Retry options are validated before the promise exists

`normalizeRetryPolicy`, `attemptTimeoutMs` and `totalBudgetMs` are checked
**outside** the `new Promise` executor, so a configuration mistake throws at the
call site like every other one in the library.

This was a bug in the first draft: validating inside the executor turned those
throws into rejections, so the same class of mistake surfaced two different
ways depending on which option was wrong. The validation tests caught it.

## D43 — Hygiene scanners judge code, not prose

The determinism scanners now strip comments before matching, as the atomicity
scanner always has. A doc comment naming `Math.random` to say what an option
defaults to is documentation; a call to it is a violation. Flagging the former
was a false positive that would have pushed the docs toward being less clear.

---

# Day 5 decisions

## D44 — `state` is the single source of truth for what an abort must release

Cancellation has to release exactly what a call currently holds, and that
differs in each of five states. Inferring it from the resources themselves
means five independent checks that must all stay in step; a named `state`
updated at every transition means one.

The ownership table at the top of `call.ts` is the contract: every resource has
one owner and one release path. The row most easily missed is the **abort
listener**, owned by the call for its whole life and removed on settle — a
caller reusing one `AbortController` across many calls would otherwise
accumulate a listener, and each listener retains the whole call closure.

## D45 — Cancelling before an attempt starts spends nothing; after, refunds nothing

Both halves matter. A pre-aborted signal is answered **before**
`registry.acquire`, so no partition is created and no capacity is reserved.
Queued and backing-off cancellations release their own resources and leave
every bucket untouched.

Once an attempt has started, the request was sent, so nothing is returned (G7).
A test replays ten cancel-immediately cycles and asserts the conservation bound
still holds — cancellation must not become a capacity generator.

## D46 — A same-turn abort beats a resolution the call has not observed

Worth stating because it reads like a coin toss and is not. Resolving a promise
schedules its `.then` as a **microtask**; `abort()` dispatches its listener
**synchronously**. So an abort issued in the same turn as the resolution wins,
and an abort issued after the microtask has run is inert.

Neither is arbitrary: the call genuinely had not observed the result when the
caller changed its mind. Both directions are pinned by tests.

## D47 — Telemetry is six flat event kinds, with no error payloads

`queued`, `delayed`, `admitted`, `retrying`, `completed`, `refused`. No
`attempt-finished`: a successful attempt is implied by `completed`, and a
failed one by `retrying` or `refused`, so an extra kind would double-report.

Every field is a **primitive**, which is what makes `Object.freeze` a complete
guarantee rather than a shallow one — there is no nested object a listener
could reach through. A test asserts that property, because it is the reason the
shallow freeze is sufficient.

Errors are deliberately absent. The classifier already saw the error; putting
it on an event would route request payloads into whatever consumes telemetry. A
test asserts a secret in an error message never appears in the event stream.

## D48 — Listener isolation: four failure modes, four closures

1. **Throws** — caught and counted. Propagating it would abandon a pump loop
   mid-queue, which is how one bad log line stops a whole key.
2. **Returns a rejected promise** (an `async` listener) — absorbed and counted.
   Left alone it becomes an unhandled rejection and can kill the process under
   `--unhandled-rejections=strict`.
3. **Re-enters the limiter** — nested emissions are buffered and flushed by the
   outer call, so depth stays at one however deeply a listener recurses.
4. **Mutates an event** — events are frozen, and see D47 for why shallow is
   enough.

Failures are reported as `stats().decisionHookErrors`, not logged. A library
that writes to the console is one you cannot silence.

## D49 — Events are emitted after the transition commits

A listener observing an `admitted` event sees the capacity already debited;
there is a test that reads `inspect()` from inside the listener to prove it. The
emit sites sit immediately after the state change and before anything else,
which is what makes "a listener never catches a half-made decision" true rather
than hoped for.

## D50 — `drain()` is a barrier, not a shutdown

It resolves when every call accepted **before** the invocation has settled,
including queued attempts and retry backoffs. It does not close the limiter,
does not reject new work, and never rejects.

Implemented as a snapshot of a live-call set, which makes "calls accepted
before the drain" an exact set rather than a heuristic, and makes repeated and
overlapping drains independent for free.

**It inherits the liveness of your tasks.** A task that never settles, with no
`attemptTimeoutMs` and no signal, holds a drain open forever. That is correct —
the work genuinely has not finished — and the integration test found it by
hanging, which is the right way to learn it.

Deliberately not built: `close()`. A caller who wants to stop accepting work
stops calling `run()`; inventing a closed state would add a refusal reason, a
new error path and a question about in-flight retries, for no capability the
caller cannot already express.

## D51 — Every refusal settles through the call, not around it

The first draft of Day 5 added each call to the live set as soon as it was
built, but the queue-full and saturated refusal paths rejected the caller's
promise **directly** instead of going through the call's `settle`. So the
internal `done` promise never resolved: `drain()` hung on a call that had
already been answered, and the live set grew by one entry per refusal — a
genuine memory leak.

The fix routes those through `refuse(error, reason)`, so there is exactly one
settle path. Found by the drain test, which hangs rather than fails if it
regresses; the virtual-clock harness reports a stall with a count, which is why
it was diagnosable in minutes rather than hours.

## D52 — Unreachable branches: eliminate where possible, annotate where not

Day 5 added four defensive guards. Coverage forced a decision on each:

- The `else` of "remove the call from its queue" was removed entirely. It was
  unreachable AND the handling was identical either way (`cancelWake` and
  `repump` are safe no-ops), so the branch should not have existed.
- `decide`'s `timedOut ? 'timeout' : 'error'` was **dead code**: a timeout only
  reaches `decide` when `retryOnAttemptTimeout` is set, which requires a
  policy. Simplified to `'error'`.
- `onAbort`'s already-settled guard was made genuinely reachable by a test: a
  shim whose `removeEventListener` is a no-op can dispatch twice.
- `settle`'s own guard, the `'idle'` case and `decide`'s settled check remain
  annotated. Each is the line that makes a stated guarantee structural rather
  than a property of several call sites all staying correct.
