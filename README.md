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
> way and QuotaPilot will warn you if you try. See
> [docs/GUARANTEES.md](docs/GUARANTEES.md) before adopting it.

---

## Status: 0.1.0-alpha — scheduling works, retries do not yet

**Available now:** multi-constraint weighted token buckets, per-key
partitioning with provably safe eviction, global and per-key concurrency caps,
bounded per-key FIFO queues with documented cross-key fairness, classified
retries with backoff and provider wait hints, per-attempt timeouts, total
budgets, and the full error taxonomy.

**Not here yet:** cancellation via `AbortSignal`, telemetry events, and
`drain()`. Each is an additive change to the surface below — types describing
unbuilt behaviour are deliberately *not* exported, because a published type is
a promise.

```ts
import {createLimiter, QuotaPilotSaturatedError} from 'quota-pilot';

const limiter = createLimiter({
  constraints: [
    {name: 'burst', limit: 5, interval: 'second'},
    {name: 'sustained', limit: 100, interval: 'minute'},
  ],
  maxConcurrent: 8,
});

// Queued if there is no capacity; never refused for being early.
const rows = await limiter.run(() => fetchPage(url), {key: credentialId});
```

Each `key` holds entirely separate capacity, so one busy account cannot slow
another. `cost` lets a call consume more than one unit, for providers that
price requests in credits.

Prefer to fail fast instead of waiting? Ask, and find out exactly what stopped
you:

```ts
try {
  await limiter.run(() => fetchPage(url), {key: credentialId, onSaturated: 'reject'});
} catch (error) {
  if (error instanceof QuotaPilotSaturatedError) {
    error.kind;    // 'rate' | 'concurrency' | 'key-concurrency' | 'queued-ahead'
    error.binding; // which limit — for 'rate', the constraint's own name
    error.waitMs;  // how long waiting would have taken
  }
}
```

Retries are classified by you, never guessed:

```ts
await limiter.run(() => fetchPage(url), {
  key: credentialId,
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

A provider's own `afterMs` is used verbatim — never jittered, never shortened
by `maxDelayMs`. Only the total budget can override it, and then the call is
refused rather than sleeping past its deadline. On ordinary exhaustion **your**
error surfaces unchanged, so `instanceof` and `.status` checks keep working.

And read capacity without spending any:

```ts
const snapshot = limiter.inspect(credentialId);
// {tracked, queued, inflight, waitingForCapacity, constraints: [{name, available, capacity, msUntilFull}]}
```

`inspect()` is free by contract: it never changes a future admission outcome or
when it happens, which is what makes it safe in a health endpoint or a hot
loop.

---

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
deliberately refuses to guess at 4 (see below).

## Design commitments

**No provider presets, ever.** Published limits change without notice. A
library that ships them ships stale facts and invites blind trust. You declare
your constraints; the README shows you how to read a provider's wording into
them.

**No built-in error classification.** When retries land, you will supply a
`classify` function; the core will contain no status codes, no header names and
no `Retry-After` parsing. Example classifiers will ship as code to copy and
own, never as an import.

**Honest guarantees.** One quantitative claim, stated formally, with a table of
what it does *not* cover — including the fact that `burst: 1` only gives strict
rolling-window behaviour when every call costs the same.

**Fairness that is written down.** Strict FIFO within a key; keys independent
of each other; contested concurrency slots handed out in the order keys became
eligible. See [docs/GUARANTEES.md](docs/GUARANTEES.md), "Queueing, fairness and
concurrency".

**Deterministic by construction.** The clock and the randomness are injected,
and the library names `Date.now`, `setTimeout` and `Math.random` in exactly two
files. A test enforces that. Every suite runs on virtual time except the single
file that tests the platform clock itself, and a test enforces that too.

**Zero runtime dependencies.** Enforced by a test, not by intention.

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

## Documentation

- [docs/GUARANTEES.md](docs/GUARANTEES.md) — the rate guarantee, weighted-cost
  limits, key eviction, which guarantees depend on cooperative cancellation,
  and the four distinct ways a call can end.
- [docs/DECISIONS.md](docs/DECISIONS.md) — every design decision that
  constrains future work, with the alternatives that were rejected.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit, strict
npm test            # vitest, virtual time only
npm run build       # dual ESM + CJS via tsc, no bundler
npm run smoke       # pack, install into ESM/CJS/TS fixtures, import, assert
npm run verify      # all four
```

Requires Node 18 or newer.

## License

MIT
