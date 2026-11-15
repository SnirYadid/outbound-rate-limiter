# Guarantees and limitations

What QuotaPilot promises, what it does not, and which promises depend on your
code cooperating. Read the limitations before the guarantees; they are the part
that decides whether this library fits your problem.

---

## Scope: one process

QuotaPilot keeps all of its state in the Node process that created the limiter.

**If you run N instances, your effective ceiling is N times what you
configured.** There is no shared store, no coordination, and no plan to add one
in 0.1.x. Every telemetry event carries `scope: 'process'` so this is visible
in your logs rather than only here.

This makes QuotaPilot a good fit for:

- a worker, job runner or CLI with a known instance count
- pacing within one request handler
- a single-instance service

and a poor fit for:

- an autoscaled fleet where the instance count is not knowable
- hourly or daily quotas (a window longer than a process lifetime cannot be
  enforced in memory; constructing one produces a `warnings` entry)
- any limit where exceeding it has a hard consequence rather than a cost

---

## The rate guarantee

A constraint is a token bucket. Let

- `B` = `burst` (defaults to `limit`) — capacity, in units
- `r` = `limit / interval` — refill rate, in units per millisecond

Then, for a single process:

| | Guarantee |
|---|---|
| **G1** | Available capacity is always within `[0, B]`. |
| **G2** | **Over any window of length `T`, total admitted cost ≤ `B + r·T`.** This bound is tight and holds for heterogeneous costs. |
| **G3** | Long-run throughput does not exceed `r`. |
| **G4** | Two consecutive admissions of cost `c` are separated by at least `(c − a)/r`, where `a` is the capacity available at the first. |
| **G5** | In any window of exactly one `interval`, total admitted cost ≤ `limit + B`. (G2 with `T = interval`.) |
| **G6** | A cost greater than `B` is rejected as a configuration error, immediately and by name. It never waits. |
| **G7** | Capacity is never refunded. Not on failure, not on timeout, not on cancellation after the attempt started. A request that was sent was paid for. |

G2 is the only quantitative claim. Everything else follows from it or bounds
the shape of the burst.

### Reading G5: the overshoot is `burst`

Set `burst` and you have set how far a burst may exceed the nominal rate. With
the default `burst = limit` you may admit up to **twice** `limit` inside one
interval: `limit` instantaneously from a full bucket, plus `limit` refilled
across the interval.

That is the same worst case as a fixed window. The bucket's real advantage is
narrower and still worth having: it bounds the **instantaneous** burst to `B`,
whereas a fixed window can emit `2 × limit` within a millisecond of a window
boundary. Rate behaviour is the same; burst behaviour is strictly better.

### Weighted requests, and why `burst: 1` is not a general answer

Lowering `burst` tightens G5. The tightest setting is **not** `1` in general —
it is **your largest cost**, because of G6: a cost above capacity can never be
admitted.

So with weighted calls:

```
minimum feasible burst = max(cost)
tightest achievable per-interval bound = limit + max(cost)
```

**`burst: 1` gives strict rolling-window behaviour only when every cost is 1.**
In that case admissions are spaced at least `interval/limit` apart, so any
trailing `interval` holds at most `limit` admissions (`limit + 1` only if the
window is closed at both ends and lands exactly on two admission instants).

As soon as a single call can cost more than one token, that property is gone,
and no token-bucket configuration restores it. A strict `≤ limit` per rolling
window with heterogeneous costs requires a sliding-window log, which this
release does not implement.

### Provider wording, mapped

| The provider says | Served? | Configuration |
|---|---|---|
| "N credits, refills at r per second" | **Exactly.** This is the model. | `limit: r × interval`, `burst: N` |
| "N per second, bursts fine" | **Yes.** | `limit: N, interval: 'second'` |
| "at most N in any rolling minute", all calls equal | **Yes, with no bursting.** | `limit: N, interval: 'minute', burst: 1` |
| "at most N in any rolling minute", weighted calls | **No.** Overshoot bounded by `max(cost)`; see above. | Tightest: `burst: max(cost)` |
| "N per minute, resets on the clock minute" | **Approximated conservatively.** The bucket paces smoothly and never exploits the reset, so you under-use the quota by up to `B` per window. | Default |
| "N per hour" / "N per day" | **No. Do not use QuotaPilot for this.** | Produces a warning |

### Floating-point slack

Capacity is tracked as a float and compared with a tolerance of `1e-9` tokens.
A request may therefore be admitted up to `1e-9` tokens early. Integer
micro-token scaling was considered and rejected: it relocates the rounding
error (the rate must still be scaled and rounded) and adds a conversion layer
at every arithmetic site.

### Clock anomalies

All arithmetic is durations, and the production clock is monotonic
(`performance.timeOrigin + performance.now()`). If you inject a wall-clock
`now` that moves backwards, a bucket **stalls** until real time catches up; it
never invents capacity. Stalling under a clock anomaly is recoverable;
inflating is a quota breach.

---

## Key eviction

State is partitioned by the `key` you pass per call. Keys are created on first
use with a **full** bucket, which is honest: a key nobody has used has consumed
nothing.

That initial condition is what makes eviction safe. A bucket that has refilled
to capacity carries no information, so dropping it is **observationally
identical** to keeping it. Therefore:

- A key is evicted **only** when every one of its buckets is provably back at
  capacity, and it has no queued and no in-flight work.
- `maxKeys` is enforced by **refusing a new key** (`QuotaPilotKeyLimitError`),
  never by discarding a partially drained one.

LRU eviction is specifically **not** used. Evicting a drained bucket and
recreating it full hands out free capacity, which is the one failure a rate
limiter must not have.

If you are hitting `maxKeys`, your key is probably too fine-grained — a key
derived from a request id, for instance, rather than from a credential.

---

## Queueing, fairness and concurrency

A call that cannot start is queued, not refused. What that queue guarantees:

| | Guarantee |
|---|---|
| **Q1** | Within one key, calls start in arrival order. Strict FIFO, no reordering. |
| **Q2** | Keys are independent. A saturated key never delays a key with capacity. |
| **Q3** | Where keys compete — the global `maxConcurrent` cap — slots are handed out in the order keys became capacity-eligible. A busy key cannot starve a quiet one. |
| **Q4** | There is **no** ordering guarantee *between* keys beyond Q3. Each key progresses on its own. |
| **Q5** | `maxConcurrent` bounds calls running across all keys; `maxConcurrentPerKey` bounds them within one key. Both are respected simultaneously. |
| **Q6** | A concurrency slot is released exactly once per call, on success, on a thrown error, and on a rejected promise alike. |
| **Q7** | Each key's queue is bounded by `maxQueueDepth`. Exceeding it rejects the returned promise with `QuotaPilotQueueFullError`, naming the key — it never grows without bound. |
| **Q8** | No polling. Every stop has exactly one matching wake: a timer for rate, the semaphore's waiter list for a slot, a call's own completion for per-key concurrency, the next enqueue for an empty queue. |
| **Q9** | Liveness: if your tasks settle, every queued call eventually runs or rejects, every queue drains, and no timer is left behind. |

### What refuses, and how

| Condition | Outcome |
|---|---|
| No capacity yet, `onSaturated: 'wait'` (default) | **Queued.** Waiting is the default. |
| No capacity yet, `onSaturated: 'reject'` | Promise rejects, `QuotaPilotSaturatedError` |
| `maxQueueDepth` reached for that key | Promise rejects, `QuotaPilotQueueFullError` |
| `maxKeys` reached and nothing safe to evict | Promise rejects, `QuotaPilotKeyLimitError` |
| `cost` above some constraint's `burst` | **Throws synchronously**, `QuotaPilotConfigError` — it could never be admitted, so waiting would be a hang |
| Invalid configuration | **Throws synchronously**, `QuotaPilotConfigError` |

### `onSaturated: 'reject'` — start now, or fail now

A rejected call is **never queued**, so it holds no capacity, no concurrency
slot and no timer, and its promise always settles. Branch on `kind`:

| `kind` | What happened | Clears when |
|---|---|---|
| `'rate'` | A rate constraint had no capacity for this cost. `binding` names it, `waitMs` says how long `'wait'` would have taken. | Time passes |
| `'concurrency'` | The limiter-wide `maxConcurrent` cap was full. | Another call finishes |
| `'key-concurrency'` | This key's `maxConcurrentPerKey` cap was full. | One of THIS key's calls finishes |
| `'queued-ahead'` | The key already had queued calls. | That key's backlog drains |

`'queued-ahead'` exists because starting ahead of a backlog would break per-key
FIFO, and that is not a theoretical concern: a cheap call can be admissible
while an expensive queued call is not, so without this refusal a stream of
cheap rejecting callers would starve the expensive one indefinitely.

`binding` is a label for the message. For `'rate'` it is a declared constraint
name; otherwise it names the option or condition responsible. **Branch on
`kind`, never on `binding`** — a constraint could be named `maxConcurrent`.

### Which constraint is reported as binding

The one with the **longest** wait, since that is the one actually being waited
on. Ties go to declaration order.

---

## `inspect()` — a snapshot that costs nothing

```ts
const snapshot = limiter.inspect('acct-1');
// {key, tracked, queued, inflight, waitingForCapacity, constraints: [...]}
```

The invariant: **calling `inspect()` never changes a future admission outcome
or when it happens.** Specifically it

- consumes no capacity and commits no refill,
- enqueues nothing and schedules no timer,
- alters no eviction eligibility,
- does not bring an unseen key into existence (`tracked: false`, with the
  full-capacity figures such a key would start with),
- and hands back frozen copies, so a caller cannot reach into live state.

Proven differentially: identical schedules replayed with and without
inspection at every step produce identical admission timelines.

**Side-effect-free does not mean static.** Projected capacity tracks elapsed
time, so two reads a moment apart legitimately differ — that is the projection
working, not a mutation.

`waitingForCapacity` distinguishes "this key's scheduler is asleep on the
clock" from "it is waiting for other calls to finish", which are different
operational problems.

---

## Guarantees conditional on cooperative cancellation

`attemptTimeoutMs` aborts the `AbortSignal` handed to your function and stops
waiting for its promise. QuotaPilot cannot force your code to stop.

**If your function ignores its signal, it keeps running after the timeout.**
The consequences are bounded and named:

| | Behaviour |
|---|---|
| **Concurrency slot** | Released at the timeout, not when the abandoned promise finally settles. |
| **Why** | Holding the slot would be more faithful to reality, but one function that never settles would then deadlock the limiter permanently. A misbehaving task should degrade the bound, not stop the world. |
| **`maxConcurrent`** | **Conditional.** It bounds attempts QuotaPilot can observe. Real concurrency may exceed it by the number of abandoned attempts, reported as `stats().abandoned`. |
| **Capacity (G2)** | **Not conditional.** The abandoned attempt consumed its cost at admission and is never refunded. |
| **Late completion** | Discarded. It cannot return a value to the caller and cannot affect control flow. It emits a `settled` event with `late: true` so you can see it happened, and its rejection is swallowed so an abandoned promise cannot crash the process with an unhandled rejection. |
| **`drain()`** | **Conditional.** Resolves when queues are empty, observable in-flight work is zero, and no timers are pending. It cannot wait for abandoned promises — they may never settle — so a non-zero `stats().abandoned` after `drain()` means work may still be running. |
| **Liveness** | Not conditional, precisely because the slot is released. |

The practical advice: thread the provided signal into whatever you call. If you
cannot, set `attemptTimeoutMs` generously or leave it unset, and read
`stats().abandoned` as the measure of how often you are exceeding your real
concurrency bound.

---

## Retry: the four ways a call ends

These are deliberately distinguishable, because the right response differs.

| Ending | What you catch | Reason on the event |
|---|---|---|
| Attempts exhausted after ordinary errors | **your last error**, unchanged | `attempts` |
| Your classifier returned `{retry: false}` | **your error**, unchanged | `not-retryable` |
| `totalBudgetMs` would be exceeded | `QuotaPilotBudgetError`, `cause` = your last error if any | `budget` |
| `signal` aborted | the signal's `reason`, else `QuotaPilotAbortError` (`name: 'AbortError'`) | `aborted` |
| `attemptTimeoutMs` fired and the attempt was not retried | `QuotaPilotTimeoutError`, **no `cause`** — the attempt produced no error, it was abandoned | `timeout` |

The governing rule: **if QuotaPilot stopped for a reason of its own, it throws
its own error. If it ran out of the attempts you configured, or your classifier
said stop, your error surfaces.** So `catch (e) { if (e instanceof
QuotaPilotError) }` reads as "the limiter refused", never "the request failed".

### No classifier, no retries

- No `retry` option: exactly one attempt. Any error propagates unchanged. None
  of the retry machinery engages.
- `retry` given without `classify`: `QuotaPilotConfigError`, thrown
  synchronously. There is no default classifier and there will not be one —
  `429` means a transient throttle at one provider, an exhausted hourly budget
  at the next and a permanent entitlement problem at a third. Guessing is worse
  than asking.

### What a retry does, mechanically

| | Guarantee |
|---|---|
| **R1** | Every retry re-enters the **tail** of its key's FIFO queue, so a hot retry loop cannot starve fresh work. |
| **R2** | Every attempt reacquires a concurrency slot and passes through normal rate admission. |
| **R3** | Weighted capacity is charged **per attempt**, at the moment the attempt starts. A retry pays again. |
| **R4** | An attempt counts toward `maxAttempts` only when it actually **starts**. A call re-queued and then refused for budget never used an attempt. |
| **R5** | A backoff holds **neither** a concurrency slot **nor** a queue entry. It is counted in `stats().backingOff`, and its partition cannot be evicted while it sleeps. |
| **R6** | A concurrency slot is released exactly once per attempt, including when a timeout and a late completion race. |
| **R7** | The caller's promise settles at most once. A straggler from a timed-out attempt can never override a later attempt's result. |
| **R8** | A retry may exceed `maxQueueDepth`: that bound governs new intake, not work already accepted. |

### Other retry semantics

- **Every attempt consumes capacity.** A retry is an outbound request; it pays.
  It also re-enters the back of its key's queue, so a hot retry loop cannot
  starve fresh work.
- **Backoff and the admission wait are sequential, not merged.** If backoff
  says 2 s and the bucket says 5 s, the wait is 7 s.
- **A provider wait hint (`afterMs`) is used verbatim** — not jittered, not
  clamped by `maxDelayMs`. Jittering a time the provider named downward earns a
  second rejection; clamping it does the same thing more reliably. Only
  `totalBudgetMs` overrides a hint, and then the call refuses rather than
  sleeping past its deadline.
- **`totalBudgetMs` runs from `run()` entry** and includes queue time. It does
  not interrupt an attempt already in flight, so worst-case wall time is
  `totalBudgetMs + attemptTimeoutMs`.
- **A queued call reaches its own deadline** without waiting for admission. It
  is checked at two points — before scheduling a backoff, and before an attempt
  starts — and a queued call additionally arms a timer for its remaining
  budget, so a long rate wait cannot hold a caller past the budget it asked
  for.
- **A classifier that throws** means "do not retry", and the error your
  operation actually produced is what surfaces. A bug in the classifier cannot
  invent a different outcome for the call.
- **A malformed `afterMs`** (negative, `NaN`, `Infinity`, not a number) is
  ignored and the computed backoff is used instead. `0` is honoured as "retry
  immediately".
- **`onSaturated` governs the first admission only.** Once a call has started,
  its retries queue normally — a caller who configured a retry policy opted
  into that policy's delays.

---

## Admission and cancellation

- Capacity across **all** constraints is checked and consumed in **one
  synchronous block with no `await` inside it**, in the same turn as the call
  to your function. Partial consumption is therefore not representable, rather
  than merely tested against.
- A failed admission consumes **nothing**: no capacity, no concurrency slot.
- **Cancelled before the attempt starts** — queued, or sleeping in a backoff or
  admission wait — consumes **nothing**.
- **Cancelled after the attempt started** does **not** refund. See G7.

---

## Telemetry safety

Your `onDecision` hook cannot corrupt the scheduler:

- Events are emitted **after** the synchronous commit, never inside it, so a
  hook can never observe half-committed state.
- Event objects are **frozen**, so a hook cannot mutate anything the limiter
  reads back.
- The hook is called synchronously and its return value is ignored. It is never
  awaited.
- A hook that throws is swallowed and counted in `stats().decisionHookErrors`.
  The library writes nothing to the console — a library that logs is a library
  you cannot silence.
- Re-entrant emission (a hook that triggers another event synchronously) is
  buffered and flushed afterwards, so it cannot recurse without bound.

---

## Not in this release

Deferred for correctness reasons, i.e. these need a redesign rather than an
addition: any shared or distributed store; persistence across restart;
clock-aligned fixed windows; sliding-window logs; cross-process fairness.

Deferred as scope: an HTTP/`fetch` adapter; adaptive tightening from response
headers; a polling helper; budgets shared across limiters; priority and
weighted fairness; circuit breaking; request caching and in-flight
deduplication; metrics exporters.

Excluded as policy, permanently: provider presets, built-in status-code
classification, and anything resembling exactly-once delivery.
