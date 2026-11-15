/**
 * Architectural invariants, enforced where enforcement demonstrably works.
 *
 * Module layering is enforced by ESLint (`eslint.config.js`), proved by
 * injecting a violation and watching it fail. Cycle detection is NOT: it needs
 * an import resolver to follow './queue.js' to queue.ts, and two documented
 * resolver configurations both left `no-unresolved` silent on an import of a
 * module that does not exist — which proves the resolver was never consulted.
 *
 * So the cycle check lives here, built from the source graph directly. It has
 * no resolver to misconfigure, and the failure message names the cycle.
 */

import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

const srcDir = join(fileURLToPath(new URL('..', import.meta.url)), 'src');

/** Internal imports of one module, as module names without extensions. */
function importsOf(moduleName: string): string[] {
  const source = readFileSync(join(srcDir, `${moduleName}.ts`), 'utf8');
  const found = new Set<string>();
  // Matches `from './name.js'` in both value and `import type` positions.
  for (const match of source.matchAll(/from '\.\/([A-Za-z0-9_-]+)\.js'/g)) {
    const name = match[1];
    if (name !== undefined) found.add(name);
  }
  return [...found];
}

function moduleNames(): string[] {
  return readdirSync(srcDir)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => file.replace(/\.ts$/, ''))
    .sort();
}

/** Returns a cycle as a readable path, or `undefined` when the graph is a DAG. */
function findCycle(graph: Map<string, string[]>): string[] | undefined {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const path: string[] = [];

  const walk = (node: string): string[] | undefined => {
    if (done.has(node)) return undefined;
    if (visiting.has(node)) {
      // Trim the prefix that is not part of the loop.
      const start = path.indexOf(node);
      return [...path.slice(start), node];
    }

    visiting.add(node);
    path.push(node);
    for (const next of graph.get(node) ?? []) {
      const cycle = walk(next);
      if (cycle !== undefined) return cycle;
    }
    path.pop();
    visiting.delete(node);
    done.add(node);
    return undefined;
  };

  for (const node of graph.keys()) {
    const cycle = walk(node);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

function buildGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const name of moduleNames()) graph.set(name, importsOf(name));
  return graph;
}

describe('architecture — the import graph', () => {
  it('has no circular imports', () => {
    const cycle = findCycle(buildGraph());

    expect(
      cycle,
      cycle === undefined ? '' : `Circular import: ${cycle.join(' -> ')}`
    ).toBeUndefined();
  });

  it('detects a cycle when one exists', () => {
    // The check is only worth having if it actually fails. A synthetic graph
    // stands in for an injected cycle, so this test proves the detector works
    // without temporarily corrupting the source tree.
    const synthetic = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ]);

    const cycle = findCycle(synthetic);
    expect(cycle).toBeDefined();
    expect(cycle?.[0]).toBe(cycle?.at(-1));
    expect(cycle).toHaveLength(4);
  });

  it('reaches every module from the public entry point', () => {
    // A module nothing imports is either dead code or an export that escaped
    // the public surface review.
    const graph = buildGraph();
    const reached = new Set<string>();
    const walk = (node: string): void => {
      if (reached.has(node)) return;
      reached.add(node);
      for (const next of graph.get(node) ?? []) walk(next);
    };
    walk('index');

    const orphans = moduleNames().filter((name) => !reached.has(name));
    expect(orphans, `unreachable from index.ts: ${orphans.join(', ')}`).toEqual([]);
  });

  it('keeps the primitive layer free of internal imports', () => {
    // Layer 0 is what makes "nothing admit.ts reaches can be async" checkable
    // by reading four short files. ESLint enforces this too; the duplication
    // is deliberate, because this is the invariant the atomicity story rests
    // on and it should fail in the test run as well as the lint run.
    const graph = buildGraph();
    for (const primitive of ['bucket', 'queue', 'random', 'semaphore', 'time']) {
      expect(graph.get(primitive), `${primitive}.ts must import nothing internal`).toEqual([]);
    }
  });

  it('keeps call.ts from importing the scheduler', () => {
    // `call` receives `repump` and `cancelWake` injected rather than importing
    // `scheduler`, which is the one thing keeping those two modules acyclic.
    // Worth its own assertion because an innocent-looking import would create
    // the cycle and the layer rule alone would not explain why it mattered.
    expect(importsOf('call')).not.toContain('scheduler');
  });
});
