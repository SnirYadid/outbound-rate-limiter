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

- The npm name `quotapilot` was already taken, so this milestone used
  `quota-pilot`. That turned out not to be publishable either — see the rename
  entry below — and the package is now `outbound-rate-limiter`. At the time the
  project was called QuotaPilot.

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
- **`LimiterSaturatedError.kind`** (`SaturationKind`): `'rate' |
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

- `LimiterSaturatedError` now **requires** `kind` in its constructor, so no
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

- **Removed `defaultRandom` and `the limiterClosedError` from the public
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
  `npm install outbound-rate-limiter@alpha` — a plain install cannot resolve a version
  that only carries the `alpha` tag.

### Targeted refactor (post-review)

An architecture and Clean Code review before publication. No public API change,
no behaviour change, same version — nothing had been published.

**Documentation (the release-blocking part).** Doc comments on the public
surface had drifted four times, and two of them shipped in the generated
`.d.ts`, which is what an editor shows on hover. `Limiter.run()` said "There
are no retries in this release"; `attemptTimeoutMs` said the `AbortSignal`
story had not arrived yet. Both features shipped milestones earlier. All four
sites corrected, plus a `Day 3` reference in `semaphore.ts` that meant nothing
to an outside reader and a settled open question in `DECISIONS.md`.

Two narrow guards now prevent a recurrence: a test scanning only the doc
comments of `index.ts` and `types.ts` for phrases that assert a shipped feature
is absent, and a check in the packaging smoke test over all 34 declaration
files in the real tarball. The second caught a case the first was too narrow to
see. Neither scans prose that legitimately describes history.

**One owner for `partition.inflight`.** It was incremented by each admission
path — the pump and the `onSaturated: 'reject'` bypass — and decremented in
`call.ts`: one counter, two writers, three files, kept in step by a comment at
each site. `call.start()` now increments it and `claimAttempt` decrements it,
fifteen lines apart in the module that owns the attempt. Safe because
`tryAdmit` reads the counter in the same synchronous turn that `start` writes
it, so the gap cannot be observed.

**The emitter owns telemetry publication.** Emitting was a four-step protocol
— gate, build, seal, dispatch — written out at four sites, and `call.ts` did
the steps in the wrong order: it built the event and only then checked whether
anyone was listening, so events were constructed and discarded on the hot path
while the comment claimed otherwise. `emitter.publish(build)` now takes a thunk
it calls only when a listener exists, and seals the result at its single exit.
Side effect: `call` and `scheduler` no longer import `telemetry` at all, so the
dependency graph lost two edges, and `Emitter.active` is gone because nothing
gates any more.

**`run()` validation extracted.** It had three jobs in 140 lines. The eight
checks now live in `normalizeRunOptions`, which documents that their ORDER is
behaviour — when several options are wrong at once, the first failure decides
which message the caller reads — and is pinned by a test that passes a call
with every option invalid and peels them off one at a time.

**Tests.** 514, up from 484. The 30 new ones guard the invariants the refactor
moved: freeze coverage for all six event kinds rather than the three one happy
path produces, lazy event construction measured differentially with a counting
clock, validation precedence, `inflight` accounting across both admission paths
including synchronous throws and re-entrant completion, buffered nested events
delivered frozen, and the observable ordering of a multi-attempt retry.

Coverage stayed at 100%. Also fixed a latent flake the work surfaced: the
`07-telemetry` example asserted an exact count of `delayed` events, which
depends on machine timing because `delayed` reports a wait rather than a call.

### Renamed before first publication

The package is `outbound-rate-limiter`. Same version — nothing had been
published, so there is nothing to supersede and no compatibility aliases are
needed.

**Why.** `quota-pilot` was rejected by the registry. npm compares names after
lowercasing and stripping punctuation, so it normalizes to `quotapilot`, which
is published by someone else — an active, unrelated package in the AI-usage
space. No hyphenation of the old name could have worked.

**Why this name rather than another.** npm search is dominated by name-token
matching: for `nodejs rate limiter` the top result is an obscure package whose
description is an unrendered `<h1>` tag, ranking above `rate-limiter-flexible`
purely on its name. And no query reliably surfaces a client-side limiter —
`outbound rate limiter`, `client side rate limit` and `rate limit api client`
all return inbound Express/Fastify/Hono middleware. `outbound` was the one
qualifier nothing on npm owned, and it is also the word that prevents the most
likely misunderstanding about what this library is for.

**The eight error classes lost the brand prefix.** They are now `LimiterError`
and friends. The prefix is `Limiter`, not `RateLimit`, deliberately: provider
SDKs call their own 429 errors `RateLimitError`, and the entire point of this
taxonomy is that `catch (e) { if (e instanceof LimiterError) }` means "the
limiter refused", never "your request failed". Naming ours the same thing would
have destroyed that distinction.

| Before | After |
|---|---|
| `QuotaPilotError` | `LimiterError` |
| `QuotaPilotConfigError` | `LimiterConfigError` |
| `QuotaPilotSaturatedError` | `LimiterSaturatedError` |
| `QuotaPilotQueueFullError` | `LimiterQueueFullError` |
| `QuotaPilotKeyLimitError` | `LimiterKeyLimitError` |
| `QuotaPilotBudgetError` | `LimiterBudgetError` |
| `QuotaPilotTimeoutError` | `LimiterTimeoutError` |
| `QuotaPilotAbortError` | `LimiterAbortError` |
| `QuotaPilotErrorDetails` | `LimiterErrorDetails` |

Inheritance, fields and behaviour are unchanged. `LimiterAbortError.name` is
still `'AbortError'` — that deviation from the class name is a deliberate
`fetch`/`DOMException` interop contract, not an oversight.

The GitHub repository was held at `SnirYadid/quota-pilot` until npm staging
proved the new package name was accepted. It did, so the repository is now
`SnirYadid/outbound-rate-limiter` and `repository`, `homepage`, `bugs` and the
README's diagram URL point there. GitHub keeps serving the old paths — web URLs
redirect, and `raw.githubusercontent.com` serves the old path directly — so the
already-staged `0.1.0-alpha.5` tarball, which has the old URLs baked in, is
unaffected.

## 0.1.0-alpha.6 — unreleased

First release intended to go out through GitHub Actions with OIDC trusted
publishing, so the artifact carries a provenance attestation. `0.1.0-alpha.5`
was published from a laptop and has none.

No runtime, public API or architecture change. The library is byte-for-byte the
same behaviour; this version exists to exercise the release path.

### Fixed

- **The release workflow could not have authenticated.** It used
  `actions/setup-node` with `registry-url`, which writes
  `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into `.npmrc`. Under
  trusted publishing there is no `NODE_AUTH_TOKEN` by design, so that line
  expands to an empty token and npm has been reported to treat it as "auth is
  already configured" and never begin the OIDC exchange — failing with
  `ENEEDAUTH`.

  Upstream disagrees with itself: npm/documentation#1960 is open against the
  official example, while actions/setup-node#1551 was closed as not
  reproducible. Rather than bet a release on whose test was right, the input is
  simply gone. Nothing needed it — the default registry is already
  registry.npmjs.org and this package is public and unscoped.

  A new step asserts no `_authToken` line exists in `.npmrc` or `~/.npmrc`
  before the publish step runs, so if a future edit reintroduces one the run
  fails with a message naming the cause rather than an `ENEEDAUTH` that points
  nowhere near it.

### Changed

- `actions/setup-node` v4 → v7 in both workflows. v4 targets Node 20, which
  GitHub now force-runs on Node 24 with a deprecation warning. Both workflows
  move together on purpose: CI then exercises the same action version the
  release workflow will use, so the release path is not the first place a
  problem with it would appear.
- README is explicit that `latest` points at the `0.0.0-stage` placeholder and
  that `@alpha` or an exact version is required. A plain install returns a
  343-byte stub containing no code, which is a confusing thing to discover on
  your own.

## 0.1.0-alpha.7 — unreleased

Documentation and packaging, from an independent consumer audit: a standalone
app installed `0.1.0-alpha.6` from the registry and ran it against a mock
provider that enforces its own rate limit. The limiter behaved correctly in
every scenario. Everything below is a gap between correct behaviour and a
correct *first* configuration, plus two packaging defects.

### Fixed

- **`exports` did not expose `./package.json`.** `require('outbound-rate-limiter/package.json')`
  threw `ERR_PACKAGE_PATH_NOT_EXPORTED`, which breaks bundlers and any code
  reading the version. Now exported, verified from a clean consumer through
  both `require` and `import ... with {type: 'json'}`.
- **Relative README links broke for npm consumers.** The README linked
  `examples/…` and `docs/…`, which resolve to nothing when read from inside
  `node_modules`. All links are now absolute GitHub URLs, verified by scanning
  the README inside the packed tarball: zero relative links remain.

### Documented

- **A global limit *and* a per-key limit.** Every constraint is partitioned by
  `key`, so three keys at `limit: 5` send up to 15/second, not 5. A single
  limiter cannot express both ceilings — there is no global constraint. The
  README now says so and shows the nested-limiter pattern, verified against a
  server enforcing 6/second: nested gives 18 calls, 0 × 429; keyed-only gives
  6 × 429 on the same work.

  Three details decide whether nesting is correct, and all three are now
  written down: the keyed limiter goes **outside** (otherwise one busy
  credential stalls the shared queue); the retry policy goes on the **outer**
  limiter; and each limiter has its own queue depth.

  The retry placement is the counter-intuitive one, so it was measured rather
  than reasoned about. With a task failing three times — retry on the outer
  limiter charges both buckets 3 times; retry on the inner charges the
  per-credential bucket **once**, silently undercounting every retry.

- **Why a correct-looking config still gets 429s.** `burst` defaults to
  `limit`, so a bucket starts full and can emit `limit + burst` in one
  interval — guarantee G5, behaving as specified. Against a provider counting
  a rolling window that is roughly double. Measured: `limit: 5` with the
  default burst put 9 calls in the first second and earned 4 × 429;
  `burst: 1` put 5 and earned none. Includes a table mapping provider wording
  to the right `burst`.

- **An orientation list** after the minimal example: the five things that bite
  people, in the order they bite, each linking to the section that explains it.

### Added

- `examples/09-global-and-per-key.ts` and `examples/10-strict-rolling-window.ts`,
  both executed by `test/examples.spec.ts` with asserted results, as every
  example is.
- `examples/` now ships in the npm package. It is the only place
  `classifiers.ts` exists — the `Retry-After` parsing and HTTP classification
  every consumer has to write — and the audit found it was not installed.
  The files are TypeScript source, which is what their header already asks for:
  copy them, do not import them.

### Cancellation across nested limiters

Found while re-verifying the nested pattern for this release, not during the
original audit. An `AbortSignal` on the outer `run` cancels the outer call and
nothing else — the inner call never hears about it. Measured mid-flight:

- signal on the outer run only: the outer rejects `AbortError`, the inner runs
  to completion, and the account limiter still reports `inflight: 1`
- signal passed to both runs and threaded into the work: the inner stops and
  the account limiter reports `inflight: 0` immediately

The caller is otherwise told the work was cancelled while it is still in
flight. Documented in the example and the README, and pinned by a test that
asserts the *wrong* arrangement's behaviour so it cannot change unnoticed.

### Deliberately not changed

- **The `burst` default.** Changing it would silently alter the rate of every
  existing configuration, and the current value is correct for providers that
  tolerate bursting. Documented instead.
- **A runtime warning when `burst === limit`.** It would fire on every
  correct-by-default configuration, which is how warnings get ignored. Not
  added without evidence that it helps more than it annoys.
