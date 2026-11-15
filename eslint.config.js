// @ts-check
/**
 * Lint configuration, with the module layering encoded as rules.
 *
 * The layering is the part worth reading. `src/` is a strict DAG: a module may
 * import only from layers BELOW it, never sideways and never upward. That is
 * what keeps the atomicity story reviewable — you can read `admit.ts` knowing
 * nothing it reaches can be asynchronous, because everything it reaches is in
 * a lower layer and those layers are themselves checked.
 *
 * The dependency direction is documented in docs/ARCHITECTURE.md. This file is
 * the enforcement; that file is the explanation. If they ever disagree, this
 * one is the truth and the other is a bug.
 */

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';

/**
 * The layers, lowest first. A module may import from any earlier array and
 * from nothing in its own array or later.
 */
const LAYERS = [
  // 0 — primitives. Pure, no internal imports at all.
  ['bucket', 'queue', 'random', 'semaphore', 'time'],
  // 1 — the public type surface. Needs Clock and RandomFn from layer 0.
  ['types'],
  // 2 — errors. Needs SaturationKind from the types.
  ['errors'],
  // 3 — domain rules: config validation, retry policy, event dispatch.
  ['constraints', 'retry', 'telemetry'],
  // 4 — per-key state and the registry that owns it.
  ['partition'],
  // 5 — reads and writes over partition state. `admit` is the critical
  //     section; `inspect` is its read-only twin.
  ['admit', 'inspect'],
  // 6 — orchestration. `call` deliberately does NOT import `scheduler`: it
  //     receives `repump` and `cancelWake` injected, which is what keeps this
  //     layer free of a cycle.
  ['call', 'scheduler'],
  // 7 — wiring. The only module that knows about all the others.
  ['limiter'],
  // 8 — the published surface, and nothing else.
  ['index'],
];

/** One override per layer, forbidding imports from that layer and above. */
const layerRules = LAYERS.map((modules, index) => {
  const forbidden = LAYERS.slice(index)
    .flat()
    .map((name) => `./${name}.js`);

  return {
    files: modules.map((name) => `src/${name}.ts`),
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: forbidden.map((path) => ({
            name: path,
            message:
              `Layer violation: src/${modules.join('|')}.ts is in layer ${index} and may only ` +
              'import from lower layers. See docs/ARCHITECTURE.md for the dependency ' +
              'direction and why it is enforced.',
          })),
        },
      ],
    },
  };
});

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // `allowDefaultProject` lets the loose files (build scripts, this
        // config) parse without being in the tsconfig project.
        projectService: {
          allowDefaultProject: ['*.js', '*.mjs', 'scripts/*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {'import-x': importX},
    rules: {
      // Only the resolution-FREE import rules live here.
      //
      // `import-x/no-cycle` is deliberately absent. It needs a resolver to
      // follow './queue.js' to queue.ts, and two documented resolver
      // configurations were tried: in both, `no-unresolved` failed to flag an
      // import of a module that does not exist, which proves the resolver was
      // never consulted. A rule that silently never fires is a false
      // assurance, so cycle detection lives in test/architecture.spec.ts
      // instead, where it is proved to work by injecting a real cycle.
      'import-x/first': 'error',
      'import-x/no-duplicates': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        {argsIgnorePattern: '^_', varsIgnorePattern: '^_'},
      ],
      // Numbers are the commonest thing this library interpolates: every
      // error message quotes a limit, a cost or a wait. Forbidding them in
      // template literals would mean String() everywhere for no safety.
      '@typescript-eslint/restrict-template-expressions': ['error', {allowNumber: true}],
      // The codebase uses `!` where an invariant guarantees an index is
      // populated, with a comment saying why (see admit.ts). That is a
      // documented decision, not an oversight.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      // Off for src, deliberately and in one place rather than as a dozen
      // scattered suppressions.
      //
      // This library validates inputs its TYPES already forbid, because a
      // published package gets called from JavaScript. `typeof options !==
      // 'object'`, an unknown interval unit, an `onSaturated` that is neither
      // value — TypeScript proves all of those unreachable and all of them
      // are reachable in practice. The rule is right about the types and
      // wrong about the audience.
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
  ...layerRules,
  {
    // Tests reach into internals on purpose: that is how the differential
    // eviction and admission-atomicity properties are proved at all.
    files: ['test/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-invalid-void-type': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
    },
  },
  {
    // Config and script files are not in the tsconfig project, so the
    // type-aware rules have no type information to work from. `files` comes
    // after the spread so it is not overwritten.
    ...tseslint.configs.disableTypeChecked,
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setImmediate: 'readonly',
        URL: 'readonly',
      },
    },
  }
);
