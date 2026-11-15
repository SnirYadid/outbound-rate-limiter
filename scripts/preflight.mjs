/**
 * Release preflight.
 *
 * Everything here is a thing that is cheap to get wrong and expensive to
 * discover after a publish, because npm versions are immutable: a wrong
 * `repository` URL, a `VERSION` constant that disagrees with `package.json`,
 * a prerelease about to take the `latest` dist-tag, a second publish of a
 * version that already exists.
 *
 * Run with `--registry` to also ask npm whether this version is already
 * published. That check needs the network, so it is opt-in locally and
 * mandatory in the release workflow.
 *
 * Exit code 0 means the checks passed, not that the release is approved.
 */

import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative) => readFileSync(join(root, relative), 'utf8');

const checkRegistry = process.argv.includes('--registry');
const failures = [];
const notes = [];

const fail = (message) => failures.push(message);
const ok = (message) => notes.push(message);

const pkg = JSON.parse(read('package.json'));

// --- placeholders ---------------------------------------------------------
// The repository URL is a placeholder until the GitHub repository exists.
// Publishing with it set would put a dead link on the package page and break
// npm provenance, which verifies the repository the tarball was built from.
const manifest = JSON.stringify(pkg);
if (manifest.includes('REPLACE_ME')) {
  const fields = Object.entries(pkg)
    .filter(([, value]) => JSON.stringify(value).includes('REPLACE_ME'))
    .map(([key]) => key);
  fail(`package.json still has placeholder values in: ${fields.join(', ')}`);
} else {
  ok('no placeholder values in package.json');
}

// --- version consistency --------------------------------------------------
// Three places state the version and all three are read by someone: npm, a
// consumer logging `VERSION`, and whoever reads the changelog.
const declared = pkg.version;
const fromSource = /export const VERSION = '([^']+)'/.exec(read('src/index.ts'))?.[1];
if (fromSource !== declared) {
  fail(`src/index.ts VERSION is ${fromSource ?? 'missing'}, package.json says ${declared}`);
} else {
  ok(`version ${declared} agrees between package.json and src/index.ts`);
}

if (existsSync(join(root, 'dist/esm/index.js'))) {
  const built = /VERSION = '([^']+)'/.exec(read('dist/esm/index.js'))?.[1];
  if (built !== declared) {
    fail(`dist/esm/index.js was built from version ${built ?? 'unknown'}; rebuild`);
  } else {
    ok('the built output carries the same version');
  }
} else {
  fail('dist/ is missing — run npm run build before the preflight');
}

if (!read('CHANGELOG.md').includes(`## ${declared}`)) {
  fail(`CHANGELOG.md has no section for ${declared}`);
} else {
  ok('the changelog has an entry for this version');
}

// --- dist-tag -------------------------------------------------------------
// A prerelease that lands on `latest` is installed by everyone who types
// `npm i quota-pilot`. publishConfig.tag is what prevents that, including on
// a manual publish from a laptop.
const prerelease = declared.includes('-');
const tag = pkg.publishConfig?.tag;
if (prerelease && tag !== 'alpha') {
  fail(`${declared} is a prerelease but publishConfig.tag is ${tag ?? 'unset'}, not "alpha"`);
} else if (!prerelease && tag === 'alpha') {
  fail(`${declared} is not a prerelease, so publishConfig.tag should not be "alpha"`);
} else {
  ok(`dist-tag ${tag ?? 'latest'} matches the version shape`);
}

// --- licence and metadata -------------------------------------------------
if (pkg.license !== 'MIT' || !existsSync(join(root, 'LICENSE'))) {
  fail('license field must be MIT and a LICENSE file must exist');
} else {
  ok('MIT license declared and present');
}

for (const field of ['repository', 'homepage', 'bugs', 'author', 'description']) {
  if (pkg[field] === undefined) fail(`package.json is missing ${field}`);
}

// --- dependencies ---------------------------------------------------------
const runtimeDeps = Object.keys(pkg.dependencies ?? {});
const peerDeps = Object.keys(pkg.peerDependencies ?? {});
if (runtimeDeps.length > 0 || peerDeps.length > 0) {
  fail(`zero runtime dependencies is a documented guarantee; found ${[...runtimeDeps, ...peerDeps].join(', ')}`);
} else {
  ok('zero runtime and peer dependencies');
}

// --- engines versus what CI actually runs ---------------------------------
// `engines` is a compatibility claim. It is only honest if the floor it names
// is a version the test suite actually runs on.
const floor = /(\d+)/.exec(pkg.engines?.node ?? '')?.[1];
const ci = read('.github/workflows/ci.yml');
const matrix = [...ci.matchAll(/'(\d+)'/g)].map((match) => match[1]);
if (floor === undefined) {
  fail('engines.node does not name a major version');
} else if (!matrix.includes(floor)) {
  fail(`engines.node claims >=${floor} but the CI matrix tests ${matrix.join(', ')}`);
} else {
  ok(`engines.node >=${floor} is tested in CI (matrix: ${matrix.join(', ')})`);
}

// --- already published? ---------------------------------------------------
if (checkRegistry) {
  let published = [];
  try {
    const raw = execFileSync('npm', ['view', `${pkg.name}`, 'versions', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw);
    published = Array.isArray(parsed) ? parsed : [parsed];
    ok(`${pkg.name} exists on npm with ${published.length} version(s)`);
  } catch (error) {
    // A 404 means the name is unclaimed, which is the expected state for a
    // first publish. Anything else is a registry problem worth stopping for.
    if (/E404|404 Not Found/.test(String(error.stderr ?? error.message))) {
      ok(`${pkg.name} is not yet on npm — this would be the first publish`);
    } else {
      fail(`could not reach the npm registry: ${String(error.stderr ?? error.message).trim()}`);
    }
  }
  if (published.includes(declared)) {
    fail(`${pkg.name}@${declared} is already published; npm versions are immutable`);
  }
}

// --- report ---------------------------------------------------------------
for (const note of notes) process.stdout.write(`  ok   ${note}\n`);
for (const failure of failures) process.stdout.write(`  FAIL ${failure}\n`);

if (failures.length > 0) {
  process.stdout.write(`\nPREFLIGHT FAIL (${failures.length})\n`);
  process.exit(1);
}
process.stdout.write('\nPREFLIGHT PASS\n');
