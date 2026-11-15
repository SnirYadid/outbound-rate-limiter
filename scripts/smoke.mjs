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
import {mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const run = (command, args, cwd) =>
  execFileSync(command, args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});

const log = (message) => process.stdout.write(`${message}\n`);

let workspace;
let failed = false;

try {
  workspace = mkdtempSync(join(tmpdir(), 'quotapilot-smoke-'));
  log(`workspace: ${workspace}`);

  // --- pack -------------------------------------------------------------
  const packOutput = run('npm', ['pack', '--pack-destination', workspace], root).trim();
  const tarball = join(workspace, packOutput.split('\n').at(-1).trim());
  log(`packed:    ${tarball}`);

  const contents = run('npm', ['pack', '--dry-run', '--json'], root);
  const [manifest] = JSON.parse(contents);
  const shipped = manifest.files.map((f) => f.path).sort();
  log(`files:     ${shipped.length} entries`);

  const unexpected = shipped.filter(
    (path) =>
      !path.startsWith('dist/') &&
      !['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'docs/GUARANTEES.md'].includes(path)
  );
  if (unexpected.length > 0) {
    throw new Error(`unexpected files in the tarball: ${unexpected.join(', ')}`);
  }
  for (const required of ['dist/esm/index.js', 'dist/cjs/index.js', 'dist/esm/index.d.ts', 'dist/cjs/index.d.ts']) {
    if (!shipped.includes(required)) throw new Error(`tarball is missing ${required}`);
  }

  // --- ESM consumer -----------------------------------------------------
  const esmDir = join(workspace, 'consumer-esm');
  installFixture(esmDir, tarball, {type: 'module'});
  writeFileSync(
    join(esmDir, 'check.mjs'),
    `import assert from 'node:assert/strict';
import {
  VERSION,
  QuotaPilotConfigError,
  QuotaPilotError,
  QuotaPilotQueueFullError,
  createLimiter,
  createSeededRandom,
  realClock,
} from 'quota-pilot';

assert.equal(typeof VERSION, 'string', 'VERSION should be a string');
assert.ok(new QuotaPilotConfigError('x') instanceof QuotaPilotError, 'error hierarchy');
assert.equal(new QuotaPilotConfigError('x').name, 'QuotaPilotConfigError');
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
assert.deepEqual(limiter.stats(), {keys: 1, queued: 0, inflight: 0}, 'drained cleanly');

// A cost no constraint can admit fails synchronously, not as a rejection.
assert.throws(() => limiter.run(() => 1, {cost: 99}), QuotaPilotConfigError);

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
await assert.rejects(() => tiny.run(() => 'overflow'), QuotaPilotQueueFullError);
void held;
void queued;

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
  QuotaPilotConfigError,
  QuotaPilotError,
  createLimiter,
  createSeededRandom,
} = require('quota-pilot');

assert.equal(typeof VERSION, 'string');
assert.ok(new QuotaPilotConfigError('x') instanceof QuotaPilotError);
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
    `import {createLimiter, QuotaPilotConfigError, VERSION} from 'quota-pilot';
import type {AttemptContext, Limiter, LimiterOptions, RateConstraint, RunOptions} from 'quota-pilot';

const constraint: RateConstraint = {name: 'per-second', limit: 10, interval: 'second'};
const options: LimiterOptions = {constraints: [constraint], maxConcurrent: 4};
const limiter: Limiter = createLimiter(options);
const runOptions: RunOptions = {key: 'acct', cost: 2};
const pending: Promise<number> = limiter.run((ctx: AttemptContext) => ctx.elapsedMs, runOptions);
const warnings: readonly string[] = limiter.warnings;
const version: string = VERSION;
const error: Error = new QuotaPilotConfigError('nope');
export {constraint, limiter, pending, warnings, version, error};
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
  if (!readdirSync(join(dir, 'node_modules')).includes('quota-pilot')) {
    throw new Error(`tarball did not install into ${dir}`);
  }
}
