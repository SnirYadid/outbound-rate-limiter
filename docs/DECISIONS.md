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
bounding *observable* in-flight work, `stats().abandoned` reports the gap, late
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

## D13 — Telemetry cannot corrupt the scheduler

Emitted after the commit, never inside it. Events are frozen. The hook is
synchronous, never awaited, and a throw is swallowed and counted in
`stats().decisionHookErrors`. Re-entrant emission is buffered and flushed
afterwards. The library writes nothing to the console.

## D14 — Single process, stated structurally

`scope: 'process'` is a literal on every event. `warnings` is populated at
construction for any window longer than 15 minutes. `describe()` returns an
operator-readable block including the fleet-ceiling line. The README says it
above the install instructions.

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
- **O4** Lint-enforced layering (`import/no-cycle`, per-layer
  `no-restricted-imports`). The hygiene test covers the globals rule today;
  the cycle rule is not yet enforced.
