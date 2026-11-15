# Changelog

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
See `docs/DAY4-PLAN.md`.
