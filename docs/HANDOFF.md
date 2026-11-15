# Handoff — end of Day 1 (M1)

## Where the project lives

`~/WebstormProjects/quotapilot` — a standalone git repository, deliberately
**outside** any other checkout. Nothing from any other codebase was read into
it; every line here was written for this project.

`git init` has run. **Nothing is committed yet** — the first commit is left to
you so the history starts exactly how you want it.

## Status: M1 complete, verified

```
npm run verify   →  typecheck + test + build + smoke, all green
```

Actual measured results:

| Check | Result |
|---|---|
| `npm run typecheck` | clean (`tsc --noEmit`, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) |
| `npm test` | **94 passed / 94**, 7 files, ~1 s |
| Coverage | **100%** statements / branches / functions / lines on every runtime module (threshold gate set at 95%) |
| `npm run build` | dual ESM + CJS + `.d.ts` + sourcemaps, via `tsc` only — no bundler |
| `npm run smoke` | PASS — packs the tarball, installs it into ESM, CJS and TypeScript fixtures, imports and asserts in each |
| `npm publish --dry-run` | succeeds; 63 files, 28.5 kB packed, 130.8 kB unpacked |
| Runtime dependencies | **zero**, enforced by a test |

## Name change you need to know about

`quotapilot` was **already taken on npm** (v0.0.14 published by someone else).
This was an M1 acceptance criterion precisely so it would not surface on
release day.

- npm package: **`quota-pilot`**
- project, docs, brand, directory: still **QuotaPilot**

`@quotapilot/core` was also free if you would rather have a scope — changing it
means editing `name` in `package.json` and the three import strings in
`scripts/smoke.mjs`.

## What exists

```
src/
  bucket.ts        weighted token bucket — pure, synchronous, clock-injected
  constraints.ts   normalization + validation + long-window warnings
  errors.ts        the full error taxonomy (locked, so later work does not churn it)
  time.ts          Clock seam; the ONLY file naming Date.now / setTimeout
  random.ts        RandomFn seam; the ONLY file naming Math.random
  types.ts         RateConstraint, IntervalUnit
  index.ts         public surface (13 exports, snapshot-locked by a test)
test/
  bucket.spec.ts         24 table-driven cases
  bucket.props.spec.ts   7 property tests incl. G2 conservation
  constraints.spec.ts    29 validation cases
  errors.spec.ts         8 taxonomy cases
  virtual-clock.spec.ts  11 cases incl. the 3 deliberate harness tests
  real-clock.spec.ts     the one suite allowed to use real time
  hygiene.spec.ts        turns the project constraints into failing tests
  harness/virtual-clock.ts
docs/
  GUARANTEES.md    what is promised, what is not, what is conditional
  DECISIONS.md     18 decisions + 4 open questions, with rejected alternatives
  HANDOFF.md       this file
scripts/
  post-build.mjs   writes the dist/*/package.json format markers
  smoke.mjs        the packaging smoke test
```

## Decisions locked this session

All six of your clarifications are now written into `docs/GUARANTEES.md` and
`docs/DECISIONS.md` as the forward contract. The ones that change later work:

1. **Weighted-cost honesty.** `burst: 1` gives strict rolling-window behaviour
   **only when every cost is 1**. The minimum feasible burst is `max(cost)`, so
   the tightest achievable per-interval bound with weighted calls is
   `limit + max(cost)`. No token bucket does better; a strict rolling bound
   under weighted costs needs a sliding-window log, which is not in 0.1.0.
   `GUARANTEES.md` states this as a table and a unit test pins the negative
   case (`bucket.spec.ts`, "does NOT pace strictly once a single cost exceeds
   one token").
2. **Timeout and concurrency.** The slot is released **at the timeout**, not
   when an abandoned promise settles — otherwise one uncooperative task
   deadlocks the limiter forever. Consequence, documented rather than hidden:
   `maxConcurrent` bounds *observable* in-flight work, the gap is reported as
   `stats().abandoned`, late completions emit `settled` with `late: true`, and
   their rejections get swallowed so an abandoned promise cannot crash the
   process. `drain()` cannot wait for them, so a non-zero `abandoned` after
   `drain()` means work may still be running.
3. **Queue liveness is mandatory.** Removed from the scope-cut list (D16).
4. **Four distinct terminations**, each separately catchable: attempts
   exhausted → *your* error; classifier said stop → *your* error;
   `totalBudgetMs` → `QuotaPilotBudgetError` with `cause`; abort → signal
   reason or `AbortError`; attempt timeout → `QuotaPilotTimeoutError` with
   **no** `cause`, because the outcome is unknown rather than failed. No
   `retry` option means one attempt; a `retry` option without `classify` is a
   synchronous `QuotaPilotConfigError`.
5. **Admission and refunds.** Commit is one synchronous block, in the same turn
   as invoking the function. Cancellation before the attempt starts consumes
   nothing; after it starts, nothing is refunded. There is deliberately no
   inverse of `commit`.
6. **Telemetry safety.** Emit after commit, frozen event objects, synchronous
   and never awaited, throws swallowed and counted, re-entrant emission
   buffered.

Also locked while building: **timers are not `unref`'d** (D15). An unref'd
timer lets Node exit while a caller is still awaiting the promise behind it,
dropping work silently. `drain()` is the route to a clean exit.

## Start here next session (M2 — Day 2)

Build the partition registry, eviction, the concurrency semaphore, and the
per-key FIFO queue with its pump. **No retry, no timeouts, no cancellation** —
those are M4 and M5. The goal is a `run()` that respects constraints and a
concurrency cap, and nothing more.

Files to add: `src/partition.ts`, `src/semaphore.ts`, `src/queue.ts`, and
enough of `src/limiter.ts` to wire them.

Acceptance criteria, from the approved plan:

- Invariants S1–S8 and P1–P4 covered by tests (listed in the plan; P1–P4 are
  restated in `GUARANTEES.md` under "Key eviction").
- **The differential eviction test**: the same arrival schedule, run once with
  eviction forced aggressively and once with eviction disabled, must produce
  byte-identical admission timelines. This is what turns P2 from a claim into
  a proof.
- Property **P-B** (in-flight never exceeds either cap) and property **P-C**
  (queue liveness: every call settles, queues drain, slots all released).
- A 500-arrival randomized interleaving test showing zero capacity leak.
- No real timers in any new test — the hygiene suite will fail you otherwise.

`peek` already returns the refilled state so that admission can refill once and
write once; M3's `admit.ts` is meant to consume that, and must contain no
`await`. A test should fail if one is ever introduced.

## Open questions carried forward

- **O1** Should the virtual clock ship as a `quota-pilot/testing` subpath?
  Probably not — users can inject their own `now`/`setTimer`. Revisit on
  request.
- **O2** Does `drain()` need `{discardQueued: true}`, or a separate hard
  `abort()`?
- **O3** `maxQueueDepth: 1024` per key is a guess and needs a real workload.
- **O4** Lint-enforced layering (`import/no-cycle`, per-layer
  `no-restricted-imports`) is **not** set up. The hygiene test covers the
  globals rule; the cycle rule does not exist yet. ESLint was skipped on Day 1
  to keep the install small — fold it into M6.

## Nothing published

`npm publish` has **not** been run. Only `--dry-run`. Publishing waits for your
go-ahead.
