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
