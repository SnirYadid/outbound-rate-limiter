/**
 * Turns the project's engineering constraints into failing tests rather than
 * good intentions.
 */

import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

import * as publicApi from '../src/index.js';
import {VERSION} from '../src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('dependency hygiene', () => {
  it('ships zero runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    expect(Object.keys(pkg.peerDependencies ?? {})).toEqual([]);
  });

  it('keeps the published VERSION in step with package.json', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {version: string};
    expect(VERSION).toBe(pkg.version);
  });
});

describe('determinism seams', () => {
  it('names Date.now and setTimeout only in time.ts', () => {
    const offenders = sourceFiles(srcDir)
      .filter((path) => !path.endsWith('time.ts'))
      .filter((path) => /\bDate\.now\b|\bsetTimeout\b|\bsetInterval\b|\bclearTimeout\b/.test(
        readFileSync(path, 'utf8')
      ))
      .map((path) => path.slice(srcDir.length + 1));

    // Anything here would be a hidden source of real time, which is how a
    // library becomes untestable without anyone deciding to make it so.
    expect(offenders).toEqual([]);
  });

  it('names Math.random only in random.ts', () => {
    const offenders = sourceFiles(srcDir)
      .filter((path) => !path.endsWith('random.ts'))
      .filter((path) => /\bMath\.random\b/.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(srcDir.length + 1));

    expect(offenders).toEqual([]);
  });

  it('keeps performance.now out of everything but time.ts', () => {
    const offenders = sourceFiles(srcDir)
      .filter((path) => !path.endsWith('time.ts'))
      .filter((path) => /\bperformance\./.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(srcDir.length + 1));

    expect(offenders).toEqual([]);
  });

  it('writes nothing to the console from library code', () => {
    const offenders = sourceFiles(srcDir)
      .filter((path) => /\bconsole\.\w+\(/.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(srcDir.length + 1));

    // A library that logs is a library you cannot silence. Telemetry goes
    // through the caller's own hook instead.
    expect(offenders).toEqual([]);
  });
});

describe('test-suite determinism', () => {
  it('confines real time to the one suite that tests the platform clock', () => {
    // The whole suite must be able to run at full speed with no wall-clock
    // dependency. `real-clock.spec.ts` is the deliberate exception: verifying
    // the platform seam requires a real timer. The virtual-clock harness uses
    // setImmediate to flush microtasks, which advances no clock.
    const allowed = new Set([
      'real-clock.spec.ts',
      join('harness', 'virtual-clock.ts'),
      // This file is the scanner: it necessarily contains the patterns it
      // looks for, so scanning itself only ever finds its own regex.
      'hygiene.spec.ts',
    ]);

    const offenders = sourceFiles(join(root, 'test'))
      .map((path) => path.slice(join(root, 'test').length + 1))
      .filter((relative) => !allowed.has(relative))
      .filter((relative) =>
        /\brealClock\b|\bsetTimeout\(|\bsetInterval\(|\bsetImmediate\(|\bDate\.now\(/.test(
          readFileSync(join(root, 'test', relative), 'utf8')
        )
      );

    expect(offenders).toEqual([]);
  });
});

describe('public surface', () => {
  it('exports exactly the settled surface for this release', () => {
    // A deliberate snapshot: adding an export should be a visible decision,
    // and nothing internal should leak out by accident.
    expect(Object.keys(publicApi).sort()).toEqual([
      'QuotaPilotAbortError',
      'QuotaPilotBudgetError',
      'QuotaPilotClosedError',
      'QuotaPilotConfigError',
      'QuotaPilotError',
      'QuotaPilotKeyLimitError',
      'QuotaPilotQueueFullError',
      'QuotaPilotSaturatedError',
      'QuotaPilotTimeoutError',
      'VERSION',
      'createSeededRandom',
      'defaultRandom',
      'realClock',
    ]);
  });

  it('does not export bucket or constraint internals', () => {
    const names = Object.keys(publicApi);
    for (const internal of ['peek', 'commit', 'refill', 'normalizeConstraints', 'createBucket']) {
      expect(names).not.toContain(internal);
    }
  });
});

describe('seeded randomness', () => {
  it('is reproducible for a given seed', () => {
    const a = publicApi.createSeededRandom(42);
    const b = publicApi.createSeededRandom(42);
    const first = Array.from({length: 8}, () => a());
    const second = Array.from({length: 8}, () => b());

    expect(first).toEqual(second);
  });

  it('differs across seeds and stays within [0, 1)', () => {
    const a = publicApi.createSeededRandom(1);
    const b = publicApi.createSeededRandom(2);
    expect(a()).not.toBe(b());

    const draws = Array.from({length: 2_000}, () => publicApi.createSeededRandom(7)());
    const stream = publicApi.createSeededRandom(99);
    for (let i = 0; i < 2_000; i++) draws.push(stream());

    for (const value of draws) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
