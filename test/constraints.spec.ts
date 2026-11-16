import {describe, expect, it} from 'vitest';

import {
  assertCostAdmissible,
  constraintWarnings,
  normalizeConstraints,
  resolveIntervalMs,
} from '../src/constraints.js';
import {LimiterConfigError} from '../src/errors.js';
import type {RateConstraint} from '../src/types.js';

describe('resolveIntervalMs', () => {
  it('maps the unit aliases', () => {
    expect(resolveIntervalMs('second')).toBe(1_000);
    expect(resolveIntervalMs('minute')).toBe(60_000);
    expect(resolveIntervalMs('hour')).toBe(3_600_000);
    expect(resolveIntervalMs('day')).toBe(86_400_000);
  });

  it('passes a number through as milliseconds', () => {
    expect(resolveIntervalMs(250)).toBe(250);
  });
});

describe('normalizeConstraints', () => {
  it('derives capacity and rate, defaulting burst to limit', () => {
    const [constraint] = normalizeConstraints([
      {name: 'per-second', limit: 10, interval: 'second'},
    ]);

    expect(constraint).toEqual({
      name: 'per-second',
      limit: 10,
      intervalMs: 1_000,
      burst: 10,
      spec: {capacity: 10, ratePerMs: 0.01},
    });
  });

  it('honours an explicit burst', () => {
    const [constraint] = normalizeConstraints([
      {name: 'credits', limit: 60, interval: 'second', burst: 4_000},
    ]);

    expect(constraint!.burst).toBe(4_000);
    expect(constraint!.spec.capacity).toBe(4_000);
    expect(constraint!.spec.ratePerMs).toBeCloseTo(0.06, 12);
  });

  it('normalizes several constraints in order', () => {
    const normalized = normalizeConstraints([
      {name: 'burst', limit: 5, interval: 'second'},
      {name: 'sustained', limit: 100, interval: 'minute'},
    ]);

    expect(normalized.map((c) => c.name)).toEqual(['burst', 'sustained']);
  });

  it('rejects an empty list', () => {
    expect(() => normalizeConstraints([])).toThrow(LimiterConfigError);
  });

  it('rejects a duplicate name, and says why it matters', () => {
    expect(() =>
      normalizeConstraints([
        {name: 'same', limit: 1, interval: 'second'},
        {name: 'same', limit: 2, interval: 'minute'},
      ])
    ).toThrow(/Duplicate constraint name/);
  });

  it.each<[string, RateConstraint]>([
    ['empty name', {name: '', limit: 1, interval: 'second'}],
    ['zero limit', {name: 'a', limit: 0, interval: 'second'}],
    ['negative limit', {name: 'a', limit: -1, interval: 'second'}],
    ['infinite limit', {name: 'a', limit: Infinity, interval: 'second'}],
    ['NaN limit', {name: 'a', limit: Number.NaN, interval: 'second'}],
    ['zero interval', {name: 'a', limit: 1, interval: 0}],
    ['negative interval', {name: 'a', limit: 1, interval: -5}],
    ['zero burst', {name: 'a', limit: 1, interval: 'second', burst: 0}],
    ['negative burst', {name: 'a', limit: 1, interval: 'second', burst: -3}],
  ])('rejects %s', (_label, constraint) => {
    expect(() => normalizeConstraints([constraint])).toThrow(LimiterConfigError);
  });

  it('rejects an unknown interval unit arriving from untyped JavaScript', () => {
    const fromJs = [{name: 'a', limit: 1, interval: 'fortnight'}] as unknown as RateConstraint[];
    expect(() => normalizeConstraints(fromJs)).toThrow(/not a known unit/);
  });

  it('rejects an unsupported strategy rather than ignoring it', () => {
    const fromJs = [
      {name: 'a', limit: 1, interval: 'second', strategy: 'sliding-log'},
    ] as unknown as RateConstraint[];
    expect(() => normalizeConstraints(fromJs)).toThrow(/not supported in this release/);
  });

  it('rejects a non-object entry', () => {
    const fromJs = [null] as unknown as RateConstraint[];
    expect(() => normalizeConstraints(fromJs)).toThrow(/must be an object/);
  });
});

describe('constraintWarnings', () => {
  it('stays silent for short windows', () => {
    const normalized = normalizeConstraints([
      {name: 'burst', limit: 5, interval: 'second'},
      {name: 'sustained', limit: 100, interval: 'minute'},
    ]);

    expect(constraintWarnings(normalized)).toEqual([]);
  });

  it('warns that a long window is not enforceable in one process', () => {
    const normalized = normalizeConstraints([{name: 'daily', limit: 10_000, interval: 'day'}]);
    const warnings = constraintWarnings(normalized);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/"daily"/);
    expect(warnings[0]).toMatch(/state in this process only/);
  });

  it('warns once per offending constraint', () => {
    const normalized = normalizeConstraints([
      {name: 'hourly', limit: 1_000, interval: 'hour'},
      {name: 'daily', limit: 10_000, interval: 'day'},
      {name: 'per-second', limit: 5, interval: 'second'},
    ]);

    expect(constraintWarnings(normalized)).toHaveLength(2);
  });
});

describe('assertCostAdmissible', () => {
  const constraints = normalizeConstraints([
    {name: 'burst', limit: 5, interval: 'second'},
    {name: 'sustained', limit: 100, interval: 'minute', burst: 100},
  ]);

  it('accepts a cost within every burst', () => {
    expect(() => assertCostAdmissible(1, constraints)).not.toThrow();
    expect(() => assertCostAdmissible(5, constraints)).not.toThrow();
  });

  it('accepts a fractional cost', () => {
    expect(() => assertCostAdmissible(0.25, constraints)).not.toThrow();
  });

  it('names the constraint a too-large cost breaks, and how to fix it', () => {
    expect(() => assertCostAdmissible(6, constraints)).toThrow(/"burst"/);
    expect(() => assertCostAdmissible(6, constraints)).toThrow(/Raise that constraint's burst/);
  });

  it.each([0, -1, Number.NaN, Infinity])('rejects a cost of %s', (cost) => {
    expect(() => assertCostAdmissible(cost, constraints)).toThrow(LimiterConfigError);
  });
});
