/**
 * Marks each build output with its module format.
 *
 * The root package.json says `"type": "module"`, so the CJS output would
 * otherwise be parsed as ESM and fail at require() time. Dropping a
 * `package.json` into each directory is the standard, bundler-free way to say
 * which is which.
 */

import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const dist = join(fileURLToPath(new URL('..', import.meta.url)), 'dist');

const markers = [
  ['esm', {type: 'module'}],
  ['cjs', {type: 'commonjs'}],
];

for (const [dir, contents] of markers) {
  const target = join(dist, dir, 'package.json');
  writeFileSync(target, `${JSON.stringify(contents, null, 2)}\n`);
  process.stdout.write(`wrote ${target}\n`);
}
