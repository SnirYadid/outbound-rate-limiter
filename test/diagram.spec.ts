/**
 * The README diagram, checked against the code it claims to describe.
 *
 * A diagram is documentation that nobody re-reads once it looks right, and
 * this one ships on the npm page and the repository front page — the first
 * thing a stranger sees. Two failure modes are worth testing for:
 *
 *   1. It drifts from the library. An error class gets renamed, an option
 *      gains a different default, a telemetry event is added — and the picture
 *      keeps describing the old shape, confidently.
 *   2. The `.mmd` source and the `.svg` the README displays drift from each
 *      other, so editing the source changes nothing a reader ever sees.
 *
 * So every name the diagram uses is asserted to exist in the code, and the two
 * files are asserted to name the same things. The prose is not checked — only
 * the identifiers, which are the part that can be wrong in a way a reader
 * would act on.
 */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

import * as publicApi from '../src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const svg = readFileSync(join(root, 'docs/diagrams/lifecycle.svg'), 'utf8');
const mmd = readFileSync(join(root, 'docs/diagrams/lifecycle.mmd'), 'utf8');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const types = readFileSync(join(root, 'src/types.ts'), 'utf8');

/** The diagram body, with the long `<desc>` accessibility text removed. */
const svgBody = svg.replace(/<desc[\s\S]*?<\/desc>/, '');
/** The Mermaid body, with the `%%` comment header removed. */
const mmdBody = mmd.replace(/^%%.*$/gm, '');

const errorsIn = (text: string): string[] =>
  [...new Set(text.match(/Limiter[A-Za-z]*Error/g) ?? [])].sort();

describe('the lifecycle diagram matches the library', () => {
  it('names only error classes that are actually exported', () => {
    const exported = Object.keys(publicApi).filter((name) => name.endsWith('Error'));

    for (const named of errorsIn(svgBody)) {
      expect(exported, `${named} appears in the SVG but is not exported`).toContain(named);
    }
    expect(errorsIn(svgBody).length).toBeGreaterThan(4);
  });

  it('names only options that exist on the public types', () => {
    // Each of these is drawn as a thing the caller sets. If one is renamed in
    // `types.ts`, the picture would otherwise keep showing the old name.
    for (const option of [
      'maxQueueDepth',
      'maxKeys',
      'onSaturated',
      'attemptTimeoutMs',
      'totalBudgetMs',
      'onDecision',
      'AttemptContext',
    ]) {
      expect(svgBody, `the diagram shows ${option}`).toContain(option);
      expect(types, `${option} is drawn but not declared in types.ts`).toContain(option);
    }
  });

  it('lists exactly the six telemetry event kinds, in the order they occur', () => {
    // The footer claims onDecision "observes every step above". That is only
    // true while this list is complete, so it is compared against the union.
    const declared = [...new Set(types.match(/readonly kind: '([a-z-]+)'/g) ?? [])]
      .map((match) => /'([a-z-]+)'/.exec(match)?.[1])
      .filter((kind): kind is string => kind !== undefined);

    expect(declared.sort()).toEqual([
      'admitted',
      'completed',
      'delayed',
      'queued',
      'refused',
      'retrying',
    ]);

    const footer = /queued, delayed, admitted, retrying, completed, refused/.exec(svgBody);
    expect(footer, 'the SVG footer must list every kind').not.toBeNull();
  });

  it('lists exactly the four saturation kinds', () => {
    // These are what `LimiterSaturatedError.kind` can be, and the diagram
    // prints them as a closed set.
    const section = /export type SaturationKind =([\s\S]*?);/.exec(types)?.[1] ?? '';
    const declared = [...new Set(section.match(/'([a-z-]+)'/g) ?? [])]
      .map((quoted) => quoted.slice(1, -1))
      .sort();

    expect(declared).toEqual(['concurrency', 'key-concurrency', 'queued-ahead', 'rate']);
    expect(svgBody).toContain('rate, concurrency, key-concurrency, queued-ahead');
  });

  it('claims no await in the admission step, which a hygiene test enforces', () => {
    // The diagram's strongest claim. `test/hygiene.spec.ts` is what makes it
    // true; this only checks the two still say the same thing.
    expect(svgBody).toContain('NO await');
    const admit = readFileSync(join(root, 'src/admit.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(admit).not.toMatch(/\bawait\b/);
  });
});

describe('the diagram source and the rendered SVG agree', () => {
  it('names the same error classes', () => {
    expect(errorsIn(mmdBody)).toEqual(errorsIn(svgBody));
  });

  it('names the same options and vocabulary', () => {
    for (const term of [
      'maxQueueDepth',
      'maxKeys',
      'onSaturated',
      'attemptTimeoutMs',
      'totalBudgetMs',
      'AttemptContext',
      'AbortSignal',
      'Retry-After',
      'queue TAIL',
    ]) {
      expect(mmdBody, `${term} is in the SVG but not the Mermaid source`).toContain(term);
    }
  });
});

describe('the README embeds the diagram', () => {
  it('shows it under a "How It Works" heading', () => {
    expect(readme).toContain('## How It Works');
  });

  it('references it by absolute URL, because npm cannot resolve a relative one', () => {
    // GitHub would resolve `docs/diagrams/lifecycle.svg` relative to the repo.
    // The npm README is served from registry.npmjs.org, where that path means
    // nothing — so the image has to be absolute or it is simply missing for
    // half the people who see it.
    const image = /!\[[^\]]*\]\((https:\/\/[^)]+lifecycle\.svg)\)/.exec(readme);
    expect(image, 'the README must embed the SVG by absolute https URL').not.toBeNull();
    expect(image?.[1]).toContain('raw.githubusercontent.com/SnirYadid/quota-pilot');
  });

  it('links the editable Mermaid source next to it', () => {
    expect(readme).toContain('docs/diagrams/lifecycle.mmd');
  });
});
