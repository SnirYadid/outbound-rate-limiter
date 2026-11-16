/**
 * Packaging smoke test.
 *
 * Packs the library exactly as npm would publish it, installs the tarball into
 * two throwaway fixtures, and imports it from both an ESM and a CommonJS
 * consumer. Unit tests never catch a broken `exports` map, a missing file in
 * `files`, or a declaration that does not resolve — this does, and it runs
 * from day one so a packaging break is never a release-day surprise.
 */

import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const run = (command, args, cwd) =>
  execFileSync(command, args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});

const log = (message) => process.stdout.write(`${message}\n`);

let workspace;
let failed = false;

try {
  workspace = mkdtempSync(join(tmpdir(), 'outbound-rl-smoke-'));
  log(`workspace: ${workspace}`);

  // --- pack -------------------------------------------------------------
  const packOutput = run('npm', ['pack', '--pack-destination', workspace], root).trim();
  const tarball = join(workspace, packOutput.split('\n').at(-1).trim());
  log(`packed:    ${tarball}`);

  const contents = run('npm', ['pack', '--dry-run', '--json'], root);
  // npm 12 changed this payload from an array of manifests to an object keyed
  // by package name. Both shapes are accepted because this script has to run
  // on whatever npm the developer or the CI runner happens to have, and a
  // packaging check that only works on one npm major is not a check.
  const parsed = JSON.parse(contents);
  const manifest = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  if (manifest?.files === undefined) {
    throw new Error(
      `npm pack --json returned an unrecognised shape (npm ${run('npm', ['--version'], root).trim()}): ` +
        `${Object.keys(parsed).join(', ')}`
    );
  }
  const shipped = manifest.files.map((f) => f.path).sort();
  log(`files:     ${shipped.length} entries`);

  const allowedDocs = [
    'package.json',
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
    'docs/ARCHITECTURE.md',
    'docs/DECISIONS.md',
    'docs/GUARANTEES.md',
  ];
  const unexpected = shipped.filter(
    (path) =>
      !path.startsWith('dist/') &&
      !path.startsWith('src/') &&
      !path.startsWith('examples/') &&
      !allowedDocs.includes(path)
  );
  if (unexpected.length > 0) {
    throw new Error(`unexpected files in the tarball: ${unexpected.join(', ')}`);
  }
  for (const required of ['dist/esm/index.js', 'dist/cjs/index.js', 'dist/esm/index.d.ts', 'dist/cjs/index.d.ts']) {
    if (!shipped.includes(required)) throw new Error(`tarball is missing ${required}`);
  }

  // Every shipped source map must point at a file that is also shipped.
  // Maps are generated with paths into `src/`, so shipping maps without `src`
  // gives a debugger nothing to open — a dangling map looks like working
  // support for stepping into the library, and is not.
  for (const path of shipped.filter((p) => p.endsWith('.map'))) {
    const map = JSON.parse(readFileSync(join(root, path), 'utf8'));
    for (const source of map.sources) {
      const resolved = join(dirname(path), source);
      if (!shipped.includes(resolved)) {
        throw new Error(`${path} points at ${resolved}, which is not in the tarball`);
      }
    }
  }

  // The declarations are what a consumer's editor shows on hover, and they are
  // generated rather than written, so a stale doc comment in `src/` reaches
  // them without anyone rereading it. A test checks the sources; this checks
  // what actually ships, for both module formats.
  const staleDocClaims = [
    /\bnot (?:here|implemented|available|supported) yet\b/i,
    /\bthere are no retries\b/i,
    /\barrives with cancellation\b/i,
    /\blater milestone\b/i,
    /\bDay [1-7]\b/,
  ];
  const declarations = shipped.filter((p) => p.endsWith('.d.ts'));
  if (declarations.length === 0) throw new Error('no declarations in the tarball');
  for (const path of declarations) {
    const text = readFileSync(join(root, path), 'utf8');
    for (const claim of staleDocClaims) {
      const found = claim.exec(text);
      if (found) {
        throw new Error(`${path} documents a shipped feature as missing: "${found[0]}"`);
      }
    }
  }
  // And the retry surface must actually be documented where a consumer looks.
  const runDocs = readFileSync(join(root, 'dist/esm/types.d.ts'), 'utf8');
  for (const feature of ['retry', 'attemptTimeoutMs', 'AbortSignal', 'onDecision']) {
    if (!runDocs.includes(feature)) {
      throw new Error(`dist/esm/types.d.ts does not mention ${feature}`);
    }
  }
  log(`docs:      ${declarations.length} declaration files checked`);

  // --- ESM consumer -----------------------------------------------------
  const esmDir = join(workspace, 'consumer-esm');
  installFixture(esmDir, tarball, {type: 'module'});
  writeFileSync(
    join(esmDir, 'check.mjs'),
    `import assert from 'node:assert/strict';
import {
  VERSION,
  LimiterConfigError,
  LimiterError,
  LimiterQueueFullError,
  LimiterSaturatedError,
  LimiterTimeoutError,
  createLimiter,
  createSeededRandom,
  realClock,
} from 'outbound-rate-limiter';

assert.equal(typeof VERSION, 'string', 'VERSION should be a string');
assert.ok(new LimiterConfigError('x') instanceof LimiterError, 'error hierarchy');
assert.equal(new LimiterConfigError('x').name, 'LimiterConfigError');
assert.equal(createSeededRandom(1)(), createSeededRandom(1)(), 'seeded random is reproducible');
assert.equal(typeof realClock.now(), 'number');
assert.ok(realClock.now() > 0, 'monotonic clock should be positive');
realClock.setTimer(() => {}, 5)();

// The real surface a consumer uses, on a real clock.
const limiter = createLimiter({
  constraints: [{name: 'burst', limit: 3, interval: 'second'}],
  maxConcurrent: 2,
});
assert.deepEqual(limiter.warnings, []);

const started = [];
const results = await Promise.all(
  [0, 1, 2].map((i) =>
    limiter.run(async (ctx) => {
      started.push(ctx.key);
      return i * 2;
    }, {key: 'acct', cost: 1})
  )
);
assert.deepEqual(results, [0, 2, 4], 'all three calls resolved in order');
assert.deepEqual(started, ['acct', 'acct', 'acct'], 'context carried the key');
assert.deepEqual(
  limiter.stats(),
  {keys: 1, queued: 0, inflight: 0, backingOff: 0, decisionHookErrors: 0},
  'drained cleanly'
);

// A cost no constraint can admit fails synchronously, not as a rejection.
assert.throws(() => limiter.run(() => 1, {cost: 99}), LimiterConfigError);

// The limiter waits rather than refusing: a 4th call on a 3/second limit is
// queued and still resolves.
const paced = createLimiter({constraints: [{name: 'p', limit: 50, interval: 'second', burst: 1}]});
const t0 = Date.now();
await Promise.all([paced.run(() => 'a'), paced.run(() => 'b')]);
assert.ok(Date.now() - t0 >= 10, 'the second call waited for capacity');

// Queue bound is enforced and reported as its own error type.
const tiny = createLimiter({
  constraints: [{name: 'p', limit: 1, interval: 'minute', burst: 1}],
  maxQueueDepth: 1,
});
const held = tiny.run(() => new Promise((r) => realClock.setTimer(r, 20)));
const queued = tiny.run(() => 'queued').catch(() => 'rejected');
await assert.rejects(() => tiny.run(() => 'overflow'), LimiterQueueFullError);
void held;
void queued;

// onSaturated: 'reject' names the binding constraint rather than queueing.
const strict = createLimiter({
  constraints: [
    {name: 'fast', limit: 100, interval: 'second'},
    {name: 'slow', limit: 1, interval: 'minute', burst: 1},
  ],
});
assert.equal(await strict.run(() => 'first', {key: 'acct'}), 'first');
const refused = await strict
  .run(() => 'second', {key: 'acct', onSaturated: 'reject'})
  .then(() => null, (error) => error);
assert.ok(refused instanceof LimiterSaturatedError, 'expected a saturation refusal');
assert.equal(refused.kind, 'rate');
assert.equal(refused.binding, 'slow', 'the slower constraint is the binding one');
assert.ok(refused.waitMs > 0);

// inspect() is read-only and does not create partitions.
const unseen = strict.inspect('never-touched');
assert.equal(unseen.tracked, false);
assert.equal(unseen.constraints.length, 2);
assert.ok(Object.isFrozen(unseen), 'snapshots are frozen');
// On a REAL clock the projection must track elapsed time, so capacity grows
// between reads. "Side-effect-free" means it consumes and commits nothing —
// not that it returns a frozen number. So the real-clock assertion is that
// capacity only ever moves UP, and never past the declared ceiling.
const before = strict.inspect('acct').constraints.map((c) => c.available);
for (let i = 0; i < 25; i++) strict.inspect('acct');
const after = strict.inspect('acct').constraints;
after.forEach((entry, index) => {
  assert.ok(
    entry.available >= before[index],
    'inspect() consumed capacity on ' + entry.name
  );
  assert.ok(entry.available <= entry.capacity, 'capacity cannot exceed its ceiling');
});

// Retries, on a real clock, with a provider hint honoured verbatim.
const retrying = createLimiter({constraints: [{name: 'r', limit: 500, interval: 'second'}]});
let tries = 0;
const retried = await retrying.run(
  (ctx) => {
    tries = ctx.attempt;
    if (ctx.attempt < 3) throw new Error('transient');
    return 'succeeded on ' + ctx.attempt;
  },
  {
    key: 'acct',
    retry: {
      maxAttempts: 5,
      jitter: 'none',
      baseDelayMs: 5,
      maxDelayMs: 5,
      classify: (error) => ({retry: error instanceof Error && error.message === 'transient'}),
    },
  }
);
assert.equal(retried, 'succeeded on 3');
assert.equal(tries, 3);
assert.deepEqual(retrying.stats(), {
  keys: 1,
  queued: 0,
  inflight: 0,
  backingOff: 0,
  decisionHookErrors: 0,
});

// Exhaustion surfaces the CALLER's error, not a wrapper.
const permanent = new Error('permanent');
const surfaced = await retrying
  .run(() => { throw permanent; }, {
    key: 'acct',
    retry: {maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 5, classify: () => ({retry: true})},
  })
  .then(() => null, (error) => error);
assert.equal(surfaced, permanent, 'the original error object must survive');

// A per-attempt timeout is its own error class, with no cause.
const timedOut = await retrying
  .run(() => new Promise(() => {}), {key: 'acct', attemptTimeoutMs: 20})
  .then(() => null, (error) => error);
assert.ok(timedOut instanceof LimiterTimeoutError, 'expected a timeout error');
assert.equal(timedOut.timeoutMs, 20);
assert.equal('cause' in timedOut, false, 'a timeout produced no error to carry');

// Cancellation, telemetry and drain, on a real clock.
const events = [];
let observerFailures = 0;
const watched = createLimiter({
  constraints: [{name: 'w', limit: 500, interval: 'second'}],
  onDecision: (event) => {
    events.push(event.kind);
    // A hostile observer must not change any outcome below.
    if (event.kind === 'admitted') throw new Error('observer threw');
    if (event.kind === 'completed') return Promise.reject(new Error('async observer failed'));
    return undefined;
  },
});

assert.equal(await watched.run(() => 'unaffected', {key: 'k'}), 'unaffected');
assert.deepEqual(events, ['queued', 'admitted', 'completed']);
observerFailures = watched.stats().decisionHookErrors;
assert.ok(observerFailures >= 1, 'a throwing observer must be counted');

// Cancellation mid-flight: the slot is freed and nothing is refunded.
const controller = new AbortController();
const cancelled = watched
  .run(({signal}) => new Promise((_resolve, rejectInner) => {
    signal.addEventListener('abort', () => rejectInner(signal.reason));
  }), {key: 'k', signal: controller.signal})
  .then(() => null, (error) => error);
controller.abort();
const abortResult = await cancelled;
assert.ok(abortResult, 'expected a cancellation');
assert.equal(abortResult.name, 'AbortError');
assert.equal(watched.stats().inflight, 0, 'the slot must be released on cancellation');

// A pre-aborted signal never reaches the registry.
const preAborted = new AbortController();
preAborted.abort();
const refusedEarly = await watched
  .run(() => 'never', {key: 'fresh-key', signal: preAborted.signal})
  .then(() => null, (error) => error);
assert.ok(refusedEarly, 'expected a refusal');

// drain() waits for accepted work, then the limiter keeps working.
const slow = watched.run(() => new Promise((r) => realClock.setTimer(() => r('slow'), 30)), {key: 'k'});
await watched.drain();
assert.equal(await slow, 'slow', 'drain must wait for accepted work');
assert.deepEqual(
  {queued: watched.stats().queued, inflight: watched.stats().inflight, backingOff: watched.stats().backingOff},
  {queued: 0, inflight: 0, backingOff: 0}
);
assert.equal(await watched.run(() => 'after', {key: 'k'}), 'after', 'drain does not close the limiter');
await watched.drain();

console.log('esm ok, version', VERSION);
`
  );
  log(`esm:       ${run('node', ['check.mjs'], esmDir).trim()}`);

  // --- CJS consumer -----------------------------------------------------
  const cjsDir = join(workspace, 'consumer-cjs');
  installFixture(cjsDir, tarball, {type: 'commonjs'});
  writeFileSync(
    join(cjsDir, 'check.cjs'),
    `const assert = require('node:assert/strict');
const {
  VERSION,
  LimiterConfigError,
  LimiterError,
  createLimiter,
  createSeededRandom,
} = require('outbound-rate-limiter');

assert.equal(typeof VERSION, 'string');
assert.ok(new LimiterConfigError('x') instanceof LimiterError);
assert.equal(createSeededRandom(2)(), createSeededRandom(2)());

(async () => {
  const limiter = createLimiter({
    constraints: [{name: 'burst', limit: 5, interval: 'second'}],
    maxConcurrentPerKey: 1,
  });
  const out = await Promise.all([
    limiter.run(() => 'one', {key: 'k'}),
    limiter.run(async () => 'two', {key: 'k'}),
  ]);
  assert.deepEqual(out, ['one', 'two']);
  assert.equal(limiter.stats().inflight, 0);

  const snapshot = limiter.inspect('k');
  assert.equal(snapshot.tracked, true);
  assert.equal(snapshot.constraints[0].name, 'burst');
  // Two of five units were spent. A range, not an exact value: on a real clock
  // the bucket refills in the milliseconds between the calls and this read.
  // The deterministic exact-value assertions live in the virtual-clock suite.
  assert.ok(
    snapshot.constraints[0].available >= 3 && snapshot.constraints[0].available < 4,
    'expected roughly 3 of 5 units left, saw ' + snapshot.constraints[0].available
  );
  assert.equal(limiter.inspect('unseen').tracked, false);
  assert.equal(await limiter.run(() => 'now', {key: 'k', onSaturated: 'reject'}), 'now');

  let tries = 0;
  const retried = await limiter.run(
    (ctx) => {
      tries = ctx.attempt;
      if (ctx.attempt < 2) throw new Error('transient');
      return 'retried';
    },
    {key: 'k', retry: {maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 5, classify: () => ({retry: true})}}
  );
  assert.equal(retried, 'retried');
  assert.equal(tries, 2);
  assert.equal(limiter.stats().backingOff, 0);

  console.log('cjs ok, version', VERSION);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`
  );
  log(`cjs:       ${run('node', ['check.cjs'], cjsDir).trim()}`);

  // --- type resolution --------------------------------------------------
  const typesDir = join(workspace, 'consumer-types');
  installFixture(typesDir, tarball, {type: 'module'});
  writeFileSync(
    join(typesDir, 'check.ts'),
    `import {createLimiter, LimiterConfigError, VERSION} from 'outbound-rate-limiter';
import type {
  AttemptContext,
  ClassifyContext,
  Decision,
  RefusalReason,
  ConstraintSnapshot,
  KeySnapshot,
  Limiter,
  LimiterOptions,
  RateConstraint,
  RetryPolicy,
  RunOptions,
  SaturationKind,
  Verdict,
} from 'outbound-rate-limiter';

const constraint: RateConstraint = {name: 'per-second', limit: 10, interval: 'second'};
const options: LimiterOptions = {constraints: [constraint], maxConcurrent: 4};
const limiter: Limiter = createLimiter(options);
const runOptions: RunOptions = {key: 'acct', cost: 2};
const pending: Promise<number> = limiter.run((ctx: AttemptContext) => ctx.elapsedMs, runOptions);
const warnings: readonly string[] = limiter.warnings;
const strictOptions: RunOptions = {key: 'acct', onSaturated: 'reject'};
const snapshot: KeySnapshot = limiter.inspect('acct');
const first: ConstraintSnapshot | undefined = snapshot.constraints[0];
const kinds: SaturationKind[] = ['rate', 'concurrency', 'key-concurrency', 'queued-ahead'];
const policy: RetryPolicy = {
  maxAttempts: 3,
  classify: (error: unknown, context: ClassifyContext): Verdict =>
    context.timedOut || error === null ? {retry: false} : {retry: true, afterMs: 250},
};
const retried: Promise<string> = limiter.run(() => 'x', {key: 'acct', retry: policy});
const reasons: RefusalReason[] = ['saturated', 'budget', 'aborted', 'timeout'];
const observer: (event: Decision) => void = (event) => void event.kind;
const withSignal: RunOptions = {signal: new AbortController().signal};
const drained: Promise<void> = limiter.drain();
const errorCount: number = limiter.stats().decisionHookErrors;
const ctxSignal: (ctx: AttemptContext) => AbortSignal = (ctx) => ctx.signal;
const version: string = VERSION;
const error: Error = new LimiterConfigError('nope');
export {
  constraint,
  limiter,
  pending,
  warnings,
  strictOptions,
  snapshot,
  first,
  kinds,
  policy,
  retried,
  reasons,
  observer,
  withSignal,
  drained,
  errorCount,
  ctxSignal,
  version,
  error,
};
`
  );
  writeFileSync(
    join(typesDir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        include: ['check.ts'],
      },
      null,
      2
    )}\n`
  );
  run('npm', ['install', '--no-audit', '--no-fund', '--save-dev', 'typescript'], typesDir);
  run('npx', ['tsc', '--project', 'tsconfig.json'], typesDir);
  log('types:     resolved under moduleResolution=NodeNext');

  log('\nSMOKE PASS');
} catch (error) {
  failed = true;
  process.stderr.write(`\nSMOKE FAIL\n${error.stderr ?? ''}${error.message ?? error}\n`);
} finally {
  if (workspace) {
    try {
      rmSync(workspace, {recursive: true, force: true});
    } catch {
      /* best effort */
    }
  }
}

process.exit(failed ? 1 : 0);

function installFixture(dir, tarball, extra) {
  execFileSync('node', ['-e', `require('node:fs').mkdirSync(${JSON.stringify(dir)},{recursive:true})`]);
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({name: 'fixture', private: true, version: '1.0.0', ...extra}, null, 2)}\n`
  );
  execFileSync('npm', ['install', '--no-audit', '--no-fund', tarball], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!readdirSync(join(dir, 'node_modules')).includes('outbound-rate-limiter')) {
    throw new Error(`tarball did not install into ${dir}`);
  }
}
