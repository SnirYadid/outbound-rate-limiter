# Changelog

`0.1.0-alpha.5` is the **first version published to npm**. The alpha.0 through
alpha.4 entries below are development history that exists only in git: they
were each a day's milestone and none of them were ever published. They are kept
because they record why the design is the way it is, not to suggest anyone
could have installed them.

## 0.1.0-alpha.0 — unreleased

Foundation layer. Published shape is the build pipeline and the guarantees, not
a usable limiter.

### Added

- Weighted token bucket (`src/bucket.ts`, internal): pure, synchronous,
  clock-injected. `createBucket`, `refill`, `peek`, `commit`, `msUntilFull`,
  `isFull`.
- Constraint normalization and validation (`src/constraints.ts`, internal),
  including the long-window warning and the "cost could never be admitted"
  check.
- Clock seam (`Clock`, `realClock`) on a monotonic source.
- Randomness seam (`RandomFn`, `defaultRandom`, `createSeededRandom`).
- Full error taxonomy, locked now so later milestones do not churn it.
- `RateConstraint` / `IntervalUnit` public types.
- Dual ESM + CJS build via `tsc` only, no bundler.
- Packaging smoke test: packs the tarball and imports it from ESM, CJS and
  TypeScript fixtures.
- `docs/GUARANTEES.md` and `docs/DECISIONS.md`.

### Not yet implemented

`createLimiter`, the per-key queue and pump, the concurrency semaphore, the
retry engine, cancellation, telemetry events, `drain()`, `stats()`.

### Notes

- The npm name `quotapilot` was already taken, so the package is `quota-pilot`.
  The project keeps the QuotaPilot name.

## 0.1.0-alpha.1 — unreleased

Day 2 (M2): keyed partitioning, concurrency and queueing. `createLimiter` now
exists and works, within the scope below.

### Added

- `createLimiter(options)` with `run`, `stats()` and `warnings`.
- Public types: `Limiter`, `LimiterOptions`, `RunOptions`, `AttemptContext`,
  `LimiterStats`.
- Keyed partition registry (`src/partition.ts`) with provably safe eviction:
  a partition is dropped only when every bucket is back at capacity and it has
  no queued or running work, so dropping it is unobservable. `maxKeys` refuses
  new keys rather than discarding capacity that is still owed.
- Counting semaphore with FIFO waiters (`src/semaphore.ts`). `tryAcquire` is
  synchronous so admission never has to await.
- Bounded per-key FIFO queue (`src/queue.ts`).
- Synchronous all-or-nothing admission across every constraint
  (`src/admit.ts`), with a test asserting the file contains no `await`.
- Per-key pump (`src/scheduler.ts`): no polling, one matching wake per stop.
- Options: `maxConcurrent`, `maxConcurrentPerKey`, `maxQueueDepth`, `maxKeys`,
  `sweepIntervalMs`, `clock`.

### Changed from the approved API sketch

- `LimiterOptions` takes `clock?: Clock` rather than separate `now` and
  `setTimer` functions. `Clock` was already exported, two loose functions
  duplicated it, and a half-override (one without the other) was a footgun.
- `run`'s task may return `T | Promise<T>` rather than only `Promise<T>`.
  Widening, so non-breaking.
- `sweepIntervalMs` is new. It is a real operator knob, and it is what lets the
  differential eviction test exercise production behaviour instead of a
  test-only hook.

### Not yet implemented

Retries, per-attempt timeouts, cancellation, telemetry events, `drain()`,
`inspect()`, `onSaturated: 'reject'`, binding-constraint names on refusals.

## 0.1.0-alpha.2 — unreleased

Day 3 (M3): admission completion and introspection.

### Added

- **Binding constraint identification.** A rate refusal now names the
  constraint responsible — the one with the longest wait, ties going to
  declaration order.
- **`QuotaPilotSaturatedError.kind`** (`SaturationKind`): `'rate' |
  'concurrency' | 'key-concurrency' | 'queued-ahead'`. The reliable
  discriminator; `binding` is a label and only names a declared constraint for
  `'rate'`.
- **`RunOptions.onSaturated`** (`'wait' | 'reject'`, default `'wait'`).
  `'reject'` means start now or fail now: the call is never queued, so it holds
  no capacity, no slot and no timer.
- **`Limiter.inspect(key?)`** returning a frozen `KeySnapshot` with per-
  constraint `ConstraintSnapshot`s. Side-effect-free by contract and proven
  differentially.

### Changed

- `QuotaPilotSaturatedError` now **requires** `kind` in its constructor, so no
  construction site can omit the discriminator. Breaking for anyone
  constructing it directly; it is a refusal the library raises, so in practice
  only the tests did.
- `AdmitOutcome` (internal) is a discriminated union on `blockedBy`, so
  `waitMs` and `binding` exist only where they are meaningful.
- Replaced two `/* c8 ignore */` guards in `admit.ts` with non-null assertions
  plus a comment stating the index-parallel invariant. Less code, two fewer
  coverage exemptions, same safety.

### Audited, deliberately unchanged

The `cost` contract: finite, greater than zero, no greater than every
constraint's `burst`, fractions allowed, violations throwing synchronously.
Two findings left as they were, now pinned by tests — `cost: null` means "use
the default" (`??`, exactly as `key` behaves), and the declared `burst` is the
real boundary rather than `burst + TOKEN_EPSILON`.

### Not yet implemented

Retries, per-attempt timeouts, cancellation, telemetry events, `drain()`.

## 0.1.0-alpha.3 — unreleased

Day 4 (M4): the retry engine.

### Added

- **`RunOptions.retry`** (`RetryPolicy`): `maxAttempts`, a required `classify`,
  `baseDelayMs`, `maxDelayMs`, `jitter` (`'full'` default), and
  `retryOnAttemptTimeout` (default **false**).
- **`RunOptions.attemptTimeoutMs`** — abandons one attempt. Its own error class
  with no `cause`, because the outcome is unknown rather than failed.
- **`RunOptions.totalBudgetMs`** — ceiling on the whole call. Checked before
  scheduling a backoff and before an attempt starts, and a queued call arms a
  timer so it settles on time without waiting for admission.
- **`LimiterOptions.random`** for reproducible jitter.
- **`AttemptContext.attempt`** (1-based) and public `ClassifyContext`,
  `Verdict`, `RetryPolicy` types.
- **`LimiterStats.backingOff`** — calls sleeping between attempts, which hold
  no queue entry and no slot.
- `Partition.backingOff` with a matching clause in the eviction predicate:
  a sleeping retry can no longer have its partition evicted underneath it.
- `BoundedFifo.remove` (a call settling on its own deadline) and `requeue`
  (a retry appending past the depth bound).
- New modules: `src/retry.ts` (pure policy validation and backoff arithmetic)
  and `src/call.ts` (one logical call across its attempts).

### Changed

- `LimiterStats` gained `backingOff`; `AttemptContext` gained `attempt`. Both
  additive, both breaking for an exact `toEqual` on those shapes.
- `QueuedCall` (internal) gained `isExpired` and `expire`, and `start` may now
  be called once per attempt rather than once per call.
- Hygiene scanners strip comments before matching, so documentation naming
  `Math.random` is no longer a false positive.

### Not yet implemented

Cancellation (`AbortSignal`), telemetry events, `drain()`.

## 0.1.0-alpha.4 — unreleased

Day 5 (M5): cancellation, telemetry and `drain()`. The feature set is now
complete for this release line.

### Added

- **`RunOptions.signal`** — `AbortSignal` cancellation, honoured before
  submission, while queued, while blocked on concurrency, while sleeping
  between attempts, and mid-attempt. Cancelling before an attempt starts spends
  no capacity; after, nothing is refunded.
- **`AttemptContext.signal`** — each attempt gets its own signal, aborted by
  the caller's signal or by `attemptTimeoutMs`.
- **`LimiterOptions.onDecision`** and the `Decision` event union: `queued`,
  `delayed`, `admitted`, `retrying`, `completed`, `refused`. Frozen, all
  primitive fields, no error objects or payloads.
- **`Limiter.drain()`** — resolves when every call accepted before the
  invocation has settled, backoffs included. Not a shutdown API.
- **`LimiterStats.decisionHookErrors`** — observer failures, counted not logged.
- Public `RefusalReason` and `DecisionBase` types.
- New module `src/telemetry.ts` (emitter with reentrancy buffering and failure
  absorption).

### Fixed

- **A live-call leak.** The queue-full and saturated refusal paths rejected the
  caller's promise directly instead of going through the call's settle, so the
  internal completion promise never resolved: `drain()` hung on a call that had
  already been answered, and the limiter's live-call set grew by one entry per
  refusal. All refusals now settle through one path.
- **Dead code in the retry engine.** `decide` chose between `'timeout'` and
  `'error'` reasons, but a timeout can only reach it when
  `retryOnAttemptTimeout` is set, which requires a policy. Simplified.

### Changed

- `LimiterStats` gained `decisionHookErrors`; `AttemptContext` gained `signal`.
  Both additive, both breaking for an exact `toEqual` on those shapes.
- Documentation no longer references a `stats().abandoned` field. It was
  designed on Day 1 and deliberately never built: nothing could decrement it,
  so it would be a leak wearing a metric's clothing. Count `refused` events
  with `reason: 'timeout'` instead.

### Not yet implemented

`close()`, lint-enforced module layering, a `fetch` adapter, shared/distributed
state. See docs/GUARANTEES.md, "Not in this release".

## 0.1.0-alpha.5 — first public release

Day 6 (M6): release hardening. No new features; one real bug fixed, one
documented limitation retracted as wrong.

### Added

- **ESLint 9 flat config** (`eslint.config.js`) on `strictTypeChecked`, with the
  nine-layer module DAG encoded as one `no-restricted-imports` override per
  layer. An upward or sideways import now fails lint with the layer named.
- **`test/architecture.spec.ts`** — cycle detection built from the source graph
  (failure message names the path), plus layer-0 purity, the deliberate absence
  of `call` → `scheduler`, and no module orphaned from `index`.
- **`test/stress.spec.ts`** — pump stack depth under 20,000 keys, 50,000 calls,
  retry storms and a work-submitting telemetry listener; and four tests pinning
  what does and does not bound accepted work.
- **`examples/`** — nine runnable files, executed by `test/examples.spec.ts`
  with their documented results asserted. The README quotes them rather than
  carrying prose that can drift.
- **`docs/ARCHITECTURE.md`** — the layers, what enforces each invariant, and why
  cycle detection is a test rather than a lint rule.
- **CI** (`.github/workflows/ci.yml`) — lint, typecheck, tests, coverage
  thresholds, build, consumer smoke and a zero-dependency assertion on Node 18,
  20 and 22.
- `src/` and `docs/{ARCHITECTURE,DECISIONS}.md` are now published. Shipped
  source maps point into `src/`, so shipping maps without it gave debuggers
  nothing to open. The smoke test now asserts every map resolves inside the
  tarball.

### Fixed

- **Constraint validation was silently untyped.** `Array.isArray()` narrows a
  `readonly T[]` to `any[]`, so testing the input array directly erased the
  element type for the rest of the function and every field check after it ran
  as unchecked `any`. The runtime check now uses a separate `unknown` local.
  Found by lint on the first run.
- `examples/classifiers.ts`: a `Retry-After` parser that tries `Number()` and
  falls through to `Date.parse()` turns `-5` into a date in 2001, because
  `Date.parse('-5')` is not `NaN`. Both header forms are now matched by shape.

### Changed

- **Removed `defaultRandom` and `QuotaPilotClosedError` from the public
  surface.** The first is reachable as the default when `random` is omitted; the
  second was never thrown by anything. Runtime exports are now 12.
- Replaced defensive `shift()` undefined guards in `semaphore.ts` and
  `telemetry.ts` with assertions plus the loop invariant that makes them safe —
  two fewer unreachable branches.
- `call.ts`: dropped a redundant `settled` check in the deadline timer and made
  the sync-throw path's attempt claim unconditional.
- Retired `docs/DAY4-PLAN.md` and `docs/HANDOFF.md`. They were day-to-day
  planning artifacts, superseded by ARCHITECTURE, GUARANTEES and DECISIONS, and
  parts of them were no longer true.

### Retracted

- **D27's recursion claim was wrong.** Day 2 recorded that a chain of
  synchronous failures across N keys "nests N deep". Stack depth is a constant
  6 frames — from 1 key to 20,000, 100 calls to 50,000, with and without
  retries. Three existing reentrancy guards already make the pump iterative in
  effect. No trampoline was needed and none was added.

### Documented

- **GUARANTEES: "What bounds accepted work."** `maxQueueDepth` bounds intake,
  not accepted calls: a retry re-enters past the bound and a backing-off call
  holds no queue entry at all. With the measured numbers, the sizing formula,
  roughly 3 KB per unsettled call, and the three ways to bound acceptance
  itself.
- **GUARANTEES: operational limits** — `stats()` is O(keys), rate waits are not
  coalesced across keys, and `delayed` telemetry counts waits rather than calls
  (a blocked call re-reports on every wake).
- README rewritten and reordered: what it does, the problem, then each feature
  in the order a reader meets it, then the four things to know before adopting
  it (single-process scope, token bucket versus sliding window, observable
  versus physical concurrency, queue depth with retries).

### Release preparation (Day 7)

Same version — nothing had been published, so there was nothing to supersede.

- **Supported Node is now 22, 24 and 26**, and `engines.node` is `>=22`. 18 and
  20 reached end of life (April 2025 and April 2026), so claiming them meant
  claiming versions that receive no security patches and that CI should not be
  running. The library's own API floor is still Node 18; the support contract
  is deliberately narrower than the code's capability.
- **Package metadata for a public release**: `repository`, `homepage`, `bugs`,
  a wider `keywords` list, and `publishConfig` pinning `access: public` and the
  `alpha` dist-tag. The repository URLs are an explicit `REPLACE_ME_OWNER`
  placeholder until the GitHub repository exists.
- **`scripts/preflight.mjs`** (`npm run preflight`) — refuses a release while
  metadata placeholders remain, when `package.json`, the `VERSION` constant and
  the built output disagree, when the changelog has no entry for the version,
  when a prerelease would take the `latest` dist-tag, when a runtime dependency
  has appeared, or when `engines.node` names a floor the CI matrix does not
  test. With `--registry` it also refuses a version that is already published.
- **`.github/workflows/release.yml`** — manual dispatch only, gated on a GitHub
  Environment, `contents: read` plus `id-token: write` and nothing else, runs
  the full check set, and stages the publish via npm trusted publishing (OIDC).
  No npm token exists anywhere in the workflow. Defaults to a dry run.
- README gained "Why choose it" (including the reasons not to), "Requirements"
  and a contributing section, and the install command is now
  `npm install quota-pilot@alpha` — a plain install cannot resolve a version
  that only carries the `alpha` tag.
