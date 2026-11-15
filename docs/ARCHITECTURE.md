# Architecture

Why the modules are arranged the way they are, and what enforces it.

The short version: `src/` is a strict DAG of nine layers. A module may import
from layers **below** it, never sideways and never upward. That is not tidiness
for its own sake — it is what makes the central correctness claim checkable by
reading four short files.

---

## The claim the layering protects

Admission must be atomic: the capacity check and the commit must share one
synchronous turn, so no other code can run between them. One `await` anywhere
in that path and two callers can both observe capacity, both commit, and exceed
the limit — with no test failing, because the race needs a specific
interleaving.

Proving "no `await` in `admit.ts`" is easy. Proving "no `await` in anything
`admit.ts` reaches" is only easy if what it reaches is small and known. The
layering is what bounds that set: `admit.ts` sits in layer 5 and can only reach
layers 0–4, and layer 0 is five files that import nothing at all.

So the layering, the hygiene test that greps `admit.ts` for `await`, and the
test that asserts layer 0 imports nothing internal are three parts of one
argument.

---

## The layers

| Layer | Modules | Role |
|---|---|---|
| 0 | `bucket` `queue` `random` `semaphore` `time` | Primitives. Import **nothing** internal. Pure or seam-only. |
| 1 | `types` | The public type surface. Needs `Clock` and `RandomFn` from layer 0. |
| 2 | `errors` | The error taxonomy. Needs `SaturationKind` from the types. |
| 3 | `constraints` `retry` `telemetry` | Domain rules: config validation, retry policy, event dispatch. |
| 4 | `partition` | Per-key state and the registry that owns it. |
| 5 | `admit` `inspect` | Operations over partition state. `admit` is the critical section; `inspect` is its read-only twin. |
| 6 | `call` `scheduler` | Orchestration: one call's lifetime, and one key's queue. |
| 7 | `limiter` | Wiring. The only module that knows about all the others. |
| 8 | `index` | The published surface, and nothing else. |

### Two arrangements worth explaining

**`call` does not import `scheduler`.** It needs to re-run the pump and cancel
a stale wake, and it receives both as injected callbacks (`repump`,
`cancelWake`) from `limiter`. Importing `scheduler` directly would put two
layer-6 modules in a cycle. There is a test asserting this specific absence,
because the import would look innocent and the reason it matters is not local.

**`types` sits below `errors`.** `QuotaPilotSaturatedError` carries a
`SaturationKind`, which is part of the public vocabulary. Putting the types
first keeps the error classes from being a second, competing source of truth
about what the library's nouns are.

---

## What enforces it

| Invariant | Enforced by | Proved by |
|---|---|---|
| Layer boundaries | ESLint `no-restricted-imports`, one override per layer (`eslint.config.js`) | Injecting an upward import and watching lint fail |
| No circular imports | `test/architecture.spec.ts`, built from the source graph | Injecting a real cycle and watching the test fail with the path |
| Layer 0 imports nothing | `test/architecture.spec.ts` | Direct assertion |
| `call` ⇏ `scheduler` | `test/architecture.spec.ts` | Direct assertion |
| No module orphaned from `index` | `test/architecture.spec.ts` | Direct assertion |
| No `await` in the admission path | `test/hygiene.spec.ts` | Source scan of `admit.ts` and its dependencies |
| No real clock or RNG outside their seams | `test/hygiene.spec.ts` | Source scan of all of `src/` |
| `inspect` never writes bucket state | `test/hygiene.spec.ts` | Source scan for assignments into `buckets[...]` |

### Why cycle detection is a test and not a lint rule

`eslint-plugin-import-x` has `no-cycle`, and it is deliberately **not** enabled.
It needs an import resolver to follow `'./queue.js'` to `queue.ts`. Two
documented resolver configurations were tried (`import-x/resolver-next` with
the TypeScript resolver, and the legacy `import-x/resolver` object form). In
both, `no-unresolved` failed to flag an import of a module that does not
exist — which proves the resolver was never consulted, and therefore that
`no-cycle` would have reported nothing however broken the graph became.

A rule that silently never fires is worse than no rule: it is a false
assurance that survives review. So the check lives where it demonstrably works,
and the failure message names the cycle.

---

## Shapes that recur

**Seams are modules, not parameters threaded everywhere.** `time` and `random`
exist so the library reads no global clock and no global RNG. Both are layer 0,
both are injectable through `LimiterOptions`, and a hygiene test asserts the
globals appear nowhere else. That is what lets the whole test suite run on
virtual time with no sleeping.

**Pure first, orchestration last.** Layers 0–3 are almost entirely pure
functions over plain data (`refill`, `peek`, `commit`, `computeBackoffMs`,
`normalizeConstraints`). The stateful parts (layers 4–7) are thin by
comparison. Every quantitative guarantee in `GUARANTEES.md` is a property of
the pure layers; the stateful layers only have to avoid losing it, which is
what the property tests check.

**One owner per resource.** Documented as a table at the top of `call.ts`:
queue entry, deadline timer, backoff timer, partition claim, concurrency slot,
timeout timer, abort listener. Each has exactly one owner and one release path.
Cancellation reads a named `state` to decide which set to release, rather than
inferring it from the resources themselves — five independent inferences that
must all stay in step is how that kind of code rots.

---

## Adding a module

1. Decide its layer from what it needs, not from what feels tidy.
2. Add it to `LAYERS` in `eslint.config.js`.
3. Run `npm run lint`. An upward or sideways import fails with the layer named.
4. Run `npm test`. The architecture suite will flag it if nothing reaches it
   from `index.ts`.

If a module seems to need an import from its own layer or above, that is the
signal to inject the dependency instead — as `call` does with `repump`.
