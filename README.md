# QuotaPilot

Outbound API rate limiting, scheduling and retries for Node. Multi-constraint
weighted token buckets, honest guarantees, deterministic tests, zero runtime
dependencies.

```bash
npm install quota-pilot
```

> **QuotaPilot bounds outbound traffic from one Node process.**
> There is no shared store. If you run N instances, your effective ceiling is
> N times what you configured. Hourly and daily quotas are not enforceable this
> way and QuotaPilot will warn you if you try. Read
> [Single-process scope](#single-process-scope) before adopting it.

**Status: 0.1.0-alpha — feature-complete, not yet published.** No new features
are planned for this release line.

---

## Contents

- [What it does](#what-it-does)
- [The problem it solves](#the-problem-it-solves)
- [Minimal example](#minimal-example)
- [Declaring constraints](#declaring-constraints)
- [Several limits at once](#several-limits-at-once)
- [Keyed limiting](#keyed-limiting)
- [Weighted costs](#weighted-costs)
- [Failing fast instead of waiting](#failing-fast-instead-of-waiting)
- [Retries](#retries)
- [Cancellation and time budgets](#cancellation-and-time-budgets)
- [Telemetry](#telemetry)
- [`drain()`](#drain)
- [`inspect()`](#inspect)
- [Single-process scope](#single-process-scope)
- [Token bucket, not a sliding window](#token-bucket-not-a-sliding-window)
- [Observable versus physical concurrency](#observable-versus-physical-concurrency)
- [Queue depth, retries, and what bounds accepted work](#queue-depth-retries-and-what-bounds-accepted-work)

---

## What it does

You give QuotaPilot the limits a provider published and a function that calls
it. QuotaPilot decides **when** that function runs, holds it back when running
it now would breach a limit, retries it when you say an error is worth
retrying, and tells you afterwards which limit made it wait.

It holds:

- **several rate limits at once**, each a weighted token bucket, all checked
  and debited in one synchronous step
- **separate capacity per key** — per credential, per account, per endpoint
- **concurrency caps**, globally and per key
- **a bounded FIFO queue per key**, with fairness written down
- **classified retries** with backoff, provider wait hints, per-attempt
  timeouts and a total budget
- **`AbortSignal` cancellation** in every state a call can be in
- **decision telemetry** that answers "why did this wait, and for how long"

It does not wrap `fetch`, does not ship provider presets, and does not guess
which errors are retryable. Those are refusals, not gaps — see
[docs/DECISIONS.md](docs/DECISIONS.md).

## The problem it solves

Pulling data from third-party APIs on a schedule means hitting the same ten
problems, in this order:

1. Providers publish limits in incompatible units — per second, per minute, per
   credential, per endpoint, and in credits where one call costs more than
   another.
2. Several limits bind at once. "5 per second and 100 per minute" is two
   constraints, and honouring one at a time lets the other trip.
3. Limits are per-key, so one process holds many independent counters.
4. `429` means a transient throttle at one provider, an exhausted hourly budget
   at the next, and a permanent entitlement problem at a third.
5. `Retry-After` is the provider telling you exactly how long to wait, and code
   that logs it then retries on its own schedule throws away the only
   authoritative signal available.
6. Retry budgets need an attempt bound *and* a time bound.
7. Application retries compound with whatever the queue or scheduler above you
   already does.
8. A timeout does not prove the remote operation failed.
9. Afterwards nobody can answer "which limit made us wait, and for how long".
10. And an in-memory limiter quietly stops being a limit the moment the service
    scales out.

QuotaPilot addresses 1, 2, 3, 5, 6, 8 and 9 directly; is explicit about 10; and
deliberately refuses to guess at 4.

## Minimal example

```ts
import {createLimiter} from 'quota-pilot';

const limiter = createLimiter({
  constraints: [{name: 'per-second', limit: 5, interval: 'second'}],
});

// Six calls, five of which fit immediately. The sixth waits for capacity
// rather than being refused: waiting is the default.
const results = await Promise.all(
  Array.from({length: 6}, (_, index) => limiter.run(() => `call-${index}`))
);
```

Every example in this README is a file under
[`examples/`](examples/), executed by `test/examples.spec.ts` with its
documented result asserted. They are not illustrations; they run in CI.

## Declaring constraints

```ts
import type {RateConstraint} from 'quota-pilot';

// "5 per second, and 100 per minute" — both enforced at once.
const constraints: RateConstraint[] = [
  {name: 'burst', limit: 5, interval: 'second'},
  {name: 'sustained', limit: 100, interval: 'minute'},
];

// A credit model: 4000 credits, refilling at 60/second.
const credits: RateConstraint[] = [
  {name: 'credits', limit: 60, interval: 'second', burst: 4000},
];
```

`name` must be unique — it is how telemetry answers "which limit bound this
call". `interval` takes milliseconds or `'second' | 'minute' | 'hour' | 'day'`.
`burst` defaults to `limit` and is also the largest `cost` the constraint can
ever admit.

Invalid configuration throws `QuotaPilotConfigError` synchronously, naming the
field. Constraints that cannot be enforced in memory — an hour or longer —
are accepted but produce a `limiter.warnings` entry rather than silently
pretending.

[docs/GUARANTEES.md](docs/GUARANTEES.md#provider-wording-mapped) maps common
provider wording onto these fields, including the two cases where the answer is
"do not use QuotaPilot for this".

## Several limits at once

Both constraints must permit a call. The one that makes you wait longest is
reported as `binding`:

```ts
const limiter = createLimiter({
  constraints: [
    {name: 'burst', limit: 5, interval: 'second'},
    {name: 'sustained', limit: 100, interval: 'minute'},
  ],
  onDecision: (event) => {
    if (event.kind === 'delayed') log.info(`waiting on ${event.binding}`);
  },
});
```

Six calls against that pair: the sixth waits, and `binding` is `'burst'` —
`sustained` still has 94 of its 100 left.
([`examples/02-multiple-limits.ts`](examples/02-multiple-limits.ts))

## Keyed limiting

Each `key` holds entirely separate capacity, so one busy account cannot slow
another:

```ts
await Promise.all([
  limiter.run(() => fetchPage(a), {key: 'account-a'}),
  limiter.run(() => fetchPage(b), {key: 'account-b'}),
]);
```

Keys are created on first use with a **full** bucket, which is honest: a key
nobody has used has consumed nothing. That initial condition is also what makes
eviction safe — a key is dropped only when every one of its buckets is provably
back at capacity and it has no queued or in-flight work, which makes dropping it
unobservable. LRU eviction is specifically not used; evicting a drained bucket
and recreating it full would hand out free capacity.

`maxKeys` (default 10,000) is enforced by **refusing a new key**, never by
discarding a partially drained one. If you are hitting it, the key is probably
too fine-grained — derived from a request id rather than from a credential.
([`examples/03-keyed.ts`](examples/03-keyed.ts))

## Weighted costs

For providers that price requests in credits:

```ts
const limiter = createLimiter({
  constraints: [{name: 'credits', limit: 60, interval: 'second', burst: 4000}],
});

await limiter.run(() => cheapCall(), {key: acct});                 // cost 1
await limiter.run(() => bulkExport(), {key: acct, cost: 500});     // costs 500
```

Cost is charged **per attempt**, at the moment the attempt starts, and is never
refunded — not on failure, not on timeout, not on cancellation after the attempt
began. A request that was sent was paid for.

A cost above a constraint's `burst` could never be admitted, so it throws
`QuotaPilotConfigError` immediately rather than waiting forever.
([`examples/04-weighted-cost.ts`](examples/04-weighted-cost.ts))

## Failing fast instead of waiting

The default is to queue. Pass `onSaturated: 'reject'` to find out immediately,
and exactly what stopped you:

```ts
import {QuotaPilotSaturatedError} from 'quota-pilot';

try {
  await limiter.run(() => fetchPage(url), {key: acct, onSaturated: 'reject'});
} catch (error) {
  if (error instanceof QuotaPilotSaturatedError) {
    error.kind;    // 'rate' | 'concurrency' | 'key-concurrency' | 'queued-ahead'
    error.binding; // which limit — for 'rate', the constraint's own name
    error.waitMs;  // how long waiting would have taken
  }
}
```

Branch on `kind`, never on `binding` — a constraint could legitimately be named
`maxConcurrent`. A rejected call is never queued, so it holds no capacity, no
slot and no timer.

## Retries

You classify; QuotaPilot schedules. There is no default classifier and there
will not be one:

```ts
await limiter.run(() => fetchPage(url), {
  key: acct,
  attemptTimeoutMs: 20_000,
  totalBudgetMs: 120_000,
  retry: {
    maxAttempts: 4,
    classify(error, {timedOut}) {
      if (timedOut) return {retry: false};            // may have succeeded
      const status = (error as {status?: number}).status;
      if (status === 429) {
        const after = retryAfterMs(error);            // your parsing, your rules
        return after === null ? {retry: true} : {retry: true, afterMs: after};
      }
      return {retry: status !== undefined && status >= 500};
    },
  },
});
```

[`examples/classifiers.ts`](examples/classifiers.ts) is a reference classifier
and `Retry-After` parser to **copy and own**, not to import. It handles both
header forms and the trap in the second one.

What the engine does with your verdict:

- Backoff is exponential from `baseDelayMs`, capped at `maxDelayMs`, then full
  jitter. Synchronised retries are how a recovering provider gets knocked over
  a second time.
- A provider's own `afterMs` is used **verbatim** — never jittered, never
  shortened by `maxDelayMs`. Only `totalBudgetMs` overrides it, and then the
  call is refused rather than sleeping past its deadline.
- Every retry re-enters the **tail** of its key's queue and passes through
  normal admission, so a hot retry loop cannot starve fresh work.
- Backoff and the admission wait are sequential, not merged: backoff of 2s plus
  a bucket wait of 5s is 7s.
- A sleeping retry holds neither a slot nor a queue entry, and its key cannot be
  evicted while it sleeps.

Four endings, deliberately distinguishable:

| Ending | What you catch |
|---|---|
| Attempts exhausted, or `{retry: false}` | **your error**, unchanged |
| `totalBudgetMs` would be exceeded | `QuotaPilotBudgetError`, `cause` = your last error |
| `signal` aborted | the signal's `reason`, else `QuotaPilotAbortError` |
| `attemptTimeoutMs` fired, no retry | `QuotaPilotTimeoutError`, **no `cause`** — abandoned, not failed |

The rule: if QuotaPilot stopped for a reason of its own it throws its own error;
if it ran out of the attempts you configured, or your classifier said stop, your
error surfaces unchanged. So `catch (e) { if (e instanceof QuotaPilotError) }`
reads as "the limiter refused", never "the request failed".
([`examples/05-retries.ts`](examples/05-retries.ts))

## Cancellation and time budgets

Cancel a call at any point in its life — queued, rate-blocked, mid-backoff or
mid-attempt:

```ts
const controller = new AbortController();
const page = limiter.run(({signal}) => fetchPage(url, {signal}), {
  key: acct,
  signal: controller.signal,
});
controller.abort();  // rejects with the signal's own reason
```

Each attempt also receives its **own** `AbortSignal` on `AttemptContext`,
aborted by your signal or by `attemptTimeoutMs`. Thread it into whatever you
call.

- Cancelling before an attempt starts spends no capacity.
- Cancelling after one starts refunds nothing. The request was sent.
- `totalBudgetMs` runs from `run()` entry and includes queue time. It does not
  interrupt an attempt already in flight, so worst-case wall time is
  `totalBudgetMs + attemptTimeoutMs`.
- A queued call reaches its own deadline without waiting for admission.
- Each logical call settles exactly once, however abort, timeout, retry and
  completion interleave.
  ([`examples/06-cancellation-and-budgets.ts`](examples/06-cancellation-and-budgets.ts))

## Telemetry

```ts
const limiter = createLimiter({
  constraints,
  onDecision(event) {
    if (event.kind === 'delayed') {
      log.info(`waited on ${event.binding} for ${event.waitMs}ms`);
    }
  },
});
```

Six event kinds — `queued`, `delayed`, `admitted`, `retrying`, `completed`,
`refused`. All frozen, every field a primitive, and deliberately carrying **no
error objects or payloads**: your classifier already saw the error, and putting
it here would route request bodies into your telemetry.

A listener that throws, rejects, or re-enters the limiter cannot change any
outcome; failures surface as `stats().decisionHookErrors`. The library writes
nothing to the console.

`delayed` reports a **wait**, not a call: a blocked call is woken by every
completion ahead of it and reports the same wait again if it is still blocked.
Count calls by `queued`.
([`examples/07-telemetry.ts`](examples/07-telemetry.ts))

## `drain()`

```ts
await limiter.drain();
```

Resolves when every call accepted **before** this invocation has settled,
including queued attempts and retry backoffs. Never rejects — it reports that
work finished, not whether it succeeded.

**Not a graceful-shutdown API.** It does not close the limiter and does not
reject new work. There is no `close()`: a caller who wants to stop accepting
work stops calling `run()`. Calls submitted after a drain begins are not part of
that barrier, and overlapping drains are independent.

It inherits the liveness of your tasks. A task that never settles, with no
`attemptTimeoutMs` and no signal, holds a drain open forever — correctly, since
the work genuinely has not finished. If a drain hangs, look for an unbounded
task before suspecting the limiter.
([`examples/08-drain.ts`](examples/08-drain.ts))

## `inspect()`

```ts
const snapshot = limiter.inspect(acct);
// {key, tracked, queued, inflight, waitingForCapacity,
//  constraints: [{name, available, capacity, msUntilFull}]}
```

Free by contract: it never changes a future admission outcome or when it
happens, which is what makes it safe in a health endpoint or a hot loop. Proven
differentially — identical schedules replayed with and without inspection at
every step produce identical admission timelines.

Side-effect-free does not mean static. Projected capacity tracks elapsed time,
so two reads a moment apart legitimately differ.

`stats()` is the limiter-wide counterpart: `keys`, `queued`, `inflight`,
`backingOff`, `decisionHookErrors`.

---

## Single-process scope

All state lives in the Node process that created the limiter. There is no
shared store, no coordination, and no plan to add one in 0.1.x.

**If you run N instances, your effective ceiling is N times what you
configured.** Every telemetry event carries `scope: 'process'` so this shows up
in your logs rather than only in documentation.

A good fit for a worker, job runner or CLI with a known instance count; pacing
inside one request handler; a single-instance service. A poor fit for an
autoscaled fleet whose instance count is not knowable, for hourly or daily
quotas (a window longer than a process lifetime cannot be enforced in memory),
or for any limit where exceeding it has a hard consequence rather than a cost.

## Token bucket, not a sliding window

Each constraint is a token bucket with capacity `B` (`burst`) refilling at
`r = limit / interval`. The quantitative claim is one line:

> Over any window of length `T`, total admitted cost ≤ `B + r·T`.

That bound is tight and holds for mixed costs. With the default `burst = limit`
you may therefore admit up to **twice** `limit` inside one interval: `limit`
instantaneously from a full bucket, plus `limit` refilled across the interval.

That is the same worst case as a fixed window. The bucket's real advantage is
narrower and still worth having: it bounds the **instantaneous** burst to `B`,
whereas a fixed window can emit `2 × limit` within a millisecond of a boundary.

Lowering `burst` tightens the bound, but the tightest feasible setting is not
`1` — it is **your largest cost**, because a cost above capacity can never be
admitted at all:

```
minimum feasible burst = max(cost)
tightest per-interval bound = limit + max(cost)
```

**`burst: 1` gives strict rolling-window behaviour only when every call costs
1.** As soon as one call can cost more, that property is gone and no
token-bucket configuration restores it. A strict `≤ limit` per rolling window
with weighted calls needs a sliding-window log, which this release does not
implement. Full statement, including floating-point slack and behaviour under
clock anomalies: [docs/GUARANTEES.md](docs/GUARANTEES.md#the-rate-guarantee).

## Observable versus physical concurrency

`attemptTimeoutMs` aborts the signal handed to your function and stops waiting
for its promise. QuotaPilot cannot force your code to stop.

If your function ignores its signal, it keeps running after the timeout. The
consequences are bounded and named:

- **The concurrency slot is released at the timeout**, not when the abandoned
  promise finally settles. Holding it would be more faithful to reality, but one
  function that never settles would then deadlock the limiter permanently. A
  misbehaving task should degrade the bound, not stop the world.
- **`maxConcurrent` is therefore conditional.** It bounds attempts QuotaPilot
  can *observe*. Real concurrency may exceed the cap by the number of tasks
  ignoring their signals.
- **Capacity is not conditional.** The abandoned attempt paid at admission and
  is never refunded.
- **A late completion is discarded**, and its rejection absorbed so it cannot
  crash the process. No event is emitted: the call already reported its outcome.
- **`drain()` is conditional** in the same way — it waits for work it can still
  observe.

Thread the provided signal into whatever you call. If you cannot, set
`attemptTimeoutMs` generously or leave it unset.

## Queue depth, retries, and what bounds accepted work

`maxQueueDepth` (default 1024, per key) is **intake** backpressure. It bounds
how many calls a key will accept while it is already backed up. It does not
bound how many accepted calls exist, and with retries those are different
numbers:

- A retry re-enters its key's queue **without** a depth check, because it was
  already accepted. So the queue can exceed `maxQueueDepth`.
- A backing-off call holds no queue entry at all, so it frees intake room while
  still being work the limiter owes you.

The quantity to reason about is accepted-unsettled calls:

```
accepted-unsettled ≈ arrival rate × (mean backoff + mean attempt time) × attempts
```

At roughly 3 KB per unsettled call, 10,000 of them is about 30 MB. It is
bounded, not leaked — the stress suite drives storms of 5,000 synchronous
failures and 1,500 retrying calls and asserts everything returns to zero with no
timers left behind.

If you need **acceptance** bounded rather than intake, `maxQueueDepth` is the
wrong tool. Use `onSaturated: 'reject'` (nothing queues, so nothing
accumulates), or `totalBudgetMs` (an accepted call cannot sit indefinitely), or
bound your own producer. Details and the measured numbers:
[docs/GUARANTEES.md](docs/GUARANTEES.md#what-bounds-accepted-work).

---

## Design commitments

**No provider presets, ever.** Published limits change without notice. A
library that ships them ships stale facts and invites blind trust.

**No built-in error classification.** The core contains no status codes, no
header names and no `Retry-After` parsing. Example classifiers ship as code to
copy and own, never as an import.

**Honest guarantees.** One quantitative claim, stated formally, with a table of
what it does not cover.

**Fairness that is written down.** Strict FIFO within a key; keys independent of
each other; contested concurrency slots handed out in the order keys became
eligible.

**Deterministic by construction.** The clock and the randomness are injected,
and the library names `Date.now`, `setTimeout` and `Math.random` in exactly two
files. A test enforces that. Every suite runs on virtual time except the two
files that test the platform clock and the examples themselves.

**Zero runtime dependencies.** Enforced by a test, not by intention.

**A layered module graph.** `src/` is a strict DAG of nine layers, enforced by
ESLint; cycle freedom, layer-0 purity and the absence of one specific import are
enforced by tests. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Documentation

- [docs/GUARANTEES.md](docs/GUARANTEES.md) — the rate guarantee, weighted costs,
  key eviction, queueing and fairness, cancellation, telemetry, what bounds
  accepted work, and which guarantees depend on cooperative cancellation.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the layers, what enforces them,
  and how to add a module.
- [docs/DECISIONS.md](docs/DECISIONS.md) — every design decision that constrains
  future work, with the alternatives that were rejected.

## Development

```bash
npm install
npm run lint        # eslint, strict type-checked + layer boundaries
npm run typecheck   # tsc --noEmit, strict
npm test            # vitest; virtual time everywhere but two files
npm run build       # dual ESM + CJS via tsc, no bundler
npm run smoke       # pack, install into ESM/CJS/TS fixtures, import, assert
npm run verify      # all five
```

Requires Node 18 or newer. Tested on 18, 20 and 22.

## License

MIT
