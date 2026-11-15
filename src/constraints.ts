/**
 * Turns user-facing `RateConstraint`s into bucket parameters, and rejects
 * configurations that could never work.
 *
 * All validation is synchronous and throws `QuotaPilotConfigError`. A bad
 * configuration is a programming error; it should fail where it was written,
 * not surface as a rejected promise three layers away.
 */

import type {BucketSpec} from './bucket.js';
import {QuotaPilotConfigError} from './errors.js';
import type {IntervalUnit, RateConstraint} from './types.js';

const INTERVAL_MS: Record<IntervalUnit, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/**
 * Intervals above this get a warning, because an in-process limiter cannot
 * enforce a window that outlives the process. Fifteen minutes is a judgement
 * call: long enough that ordinary per-minute limits stay quiet, short enough
 * to flag the hourly and daily quotas that genuinely need shared state.
 */
export const LONG_WINDOW_MS = 15 * 60_000;

export interface NormalizedConstraint {
  readonly name: string;
  readonly limit: number;
  readonly intervalMs: number;
  readonly burst: number;
  readonly spec: BucketSpec;
}

export function resolveIntervalMs(interval: number | IntervalUnit): number {
  if (typeof interval === 'number') return interval;
  return INTERVAL_MS[interval];
}

export function normalizeConstraints(
  input: readonly RateConstraint[]
): NormalizedConstraint[] {
  // The runtime check is done on a separate `unknown` local on purpose.
  // `Array.isArray` narrows a `readonly T[]` to `any[]`, so testing `input`
  // directly would erase the element type for the whole function below — and
  // every field validation after it would be unchecked `any`. Lint caught
  // this; the types had been quietly off since day one.
  const asUnknown: unknown = input;
  if (!Array.isArray(asUnknown) || input.length === 0) {
    throw new QuotaPilotConfigError('At least one rate constraint is required.');
  }

  const seen = new Set<string>();
  return input.map((constraint, index) => {
    const where = `constraints[${index}]`;

    if (typeof constraint !== 'object' || constraint === null) {
      throw new QuotaPilotConfigError(`${where} must be an object.`);
    }
    const {name, limit, interval, burst, strategy} = constraint;

    if (typeof name !== 'string' || name.length === 0) {
      throw new QuotaPilotConfigError(`${where}.name must be a non-empty string.`);
    }
    if (seen.has(name)) {
      throw new QuotaPilotConfigError(
        `Duplicate constraint name ${JSON.stringify(name)}. ` +
          'Names identify which limit bound a call, so they must be unique.'
      );
    }
    seen.add(name);

    if (strategy !== undefined && strategy !== 'bucket') {
      throw new QuotaPilotConfigError(
        `${where}.strategy ${JSON.stringify(strategy)} is not supported in this release. ` +
          "Omit it, or pass 'bucket'."
      );
    }

    assertPositiveFinite(limit, `${where}.limit`);
    const intervalMs = parseInterval(interval, `${where}.interval`);

    const resolvedBurst = burst ?? limit;
    assertPositiveFinite(resolvedBurst, `${where}.burst`);

    return {
      name,
      limit,
      intervalMs,
      burst: resolvedBurst,
      spec: {capacity: resolvedBurst, ratePerMs: limit / intervalMs},
    };
  });
}

/**
 * Warnings about a configuration that is legal but will not do what the author
 * probably expects. Returned as data rather than logged: a library that writes
 * to the console is a library you cannot silence.
 */
export function constraintWarnings(
  constraints: readonly NormalizedConstraint[]
): string[] {
  const warnings: string[] = [];
  for (const constraint of constraints) {
    if (constraint.intervalMs > LONG_WINDOW_MS) {
      warnings.push(
        `Constraint ${JSON.stringify(constraint.name)} spans ` +
          `${Math.round(constraint.intervalMs / 60_000)} minutes. QuotaPilot keeps its ` +
          'state in this process only, so a window longer than the process lifetime is ' +
          'not enforceable: a restart resets it, and several instances each get the ' +
          'full allowance. Enforce long quotas in shared storage instead.'
      );
    }
  }
  return warnings;
}

/**
 * Rejects a cost no constraint could ever admit.
 *
 * Checked up front and thrown, never waited on: a cost above capacity makes
 * the bucket's wait `Infinity`, and a call that waits forever is far worse to
 * debug than one that fails immediately naming the constraint it broke.
 */
export function assertCostAdmissible(
  cost: number,
  constraints: readonly NormalizedConstraint[]
): void {
  assertPositiveFinite(cost, 'cost');
  for (const constraint of constraints) {
    if (cost > constraint.burst) {
      throw new QuotaPilotConfigError(
        `cost ${cost} exceeds the burst capacity of constraint ` +
          `${JSON.stringify(constraint.name)} (${constraint.burst}), so it could never be ` +
          `admitted. Raise that constraint's burst to at least your largest cost.`
      );
    }
  }
}

/**
 * Resolves a unit alias or a millisecond count.
 *
 * The `undefined` branch is unreachable through the public types but very
 * reachable from untyped JavaScript, and a silently `undefined` interval would
 * produce a `NaN` rate and a bucket that admits everything forever.
 */
function parseInterval(interval: number | IntervalUnit, label: string): number {
  if (typeof interval === 'string') {
    const resolved: number | undefined = INTERVAL_MS[interval];
    if (resolved === undefined) {
      throw new QuotaPilotConfigError(
        `${label} ${JSON.stringify(interval)} is not a known unit. ` +
          "Use milliseconds, or one of 'second' | 'minute' | 'hour' | 'day'."
      );
    }
    return resolved;
  }
  assertPositiveFinite(interval, label);
  return interval;
}

function assertPositiveFinite(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new QuotaPilotConfigError(
      `${label} must be a finite number greater than 0, received ${JSON.stringify(value)}.`
    );
  }
}
