/**
 * The error taxonomy.
 *
 * The governing rule, and the reason the taxonomy looks asymmetric:
 *
 *   - If QuotaPilot stopped for a reason of its OWN — a deadline, a full
 *     queue, a key cap, cancellation, a per-attempt timeout — it throws one of
 *     these, with `cause` set to the caller's last error when one exists.
 *
 *   - If QuotaPilot ran out of the attempts the CALLER configured, or the
 *     caller's own classifier said stop, the caller's error surfaces
 *     unchanged. Wrapping it would break `instanceof` and `.status` checks in
 *     the caller's code, and the attempt count is already on the telemetry
 *     event.
 *
 * So `catch (e) { if (e instanceof QuotaPilotError) ... }` means "the limiter
 * refused", never "your request failed".
 */

import type {SaturationKind} from './types.js';

export interface QuotaPilotErrorDetails {
  /** The partition key the call was running under, when known. */
  readonly key?: string;
  /** 1-based attempt number at the moment of refusal, when known. */
  readonly attempt?: number;
  /** Milliseconds since `run()` was entered, when known. */
  readonly elapsedMs?: number;
  /** The caller's last error, when one exists. */
  readonly cause?: unknown;
}

export class QuotaPilotError extends Error {
  readonly key: string | undefined;
  readonly attempt: number | undefined;
  readonly elapsedMs: number | undefined;

  constructor(message: string, details: QuotaPilotErrorDetails = {}) {
    super(message, 'cause' in details ? {cause: details.cause} : undefined);
    // Set explicitly rather than from `new.target.name`, which a minifier can
    // mangle. Every subclass restates it.
    this.name = 'QuotaPilotError';
    this.key = details.key;
    this.attempt = details.attempt;
    this.elapsedMs = details.elapsedMs;
  }
}

/**
 * Invalid configuration. Always thrown synchronously — from `createLimiter`
 * for static problems (a duplicate constraint name, a non-positive limit) and
 * from `run()` for per-call problems (a cost no constraint could ever admit, a
 * retry policy with no classifier). Never surfaces as a rejected promise,
 * because a configuration mistake is a programming error and should fail where
 * it was written.
 */
export class QuotaPilotConfigError extends QuotaPilotError {
  constructor(message: string, details?: QuotaPilotErrorDetails) {
    super(message, details);
    this.name = 'QuotaPilotConfigError';
  }
}

/**
 * `onSaturated: 'reject'` and the call could not start immediately.
 *
 * Branch on `kind`, not on `binding`. `binding` is a human-readable label for
 * the message and is only a declared constraint name when `kind` is `'rate'`;
 * for the other kinds it names the option or the condition responsible, which
 * a constraint could in principle be named after.
 */
export class QuotaPilotSaturatedError extends QuotaPilotError {
  /** What stopped the call. The reliable discriminator. */
  readonly kind: SaturationKind;
  /**
   * How long the caller would have waited had it chosen `'wait'`. Meaningful
   * for `kind: 'rate'`; `0` elsewhere, where the wait depends on other calls
   * finishing rather than on elapsed time.
   */
  readonly waitMs: number;
  /**
   * Label for what bound: the constraint's name for `'rate'`, the option name
   * for the concurrency kinds, `'queue'` for `'queued-ahead'`.
   */
  readonly binding: string;

  constructor(
    message: string,
    info: QuotaPilotErrorDetails & {kind: SaturationKind; waitMs: number; binding: string}
  ) {
    super(message, info);
    this.name = 'QuotaPilotSaturatedError';
    this.kind = info.kind;
    this.waitMs = info.waitMs;
    this.binding = info.binding;
  }
}

/** The key's wait queue was at `maxQueueDepth`. */
export class QuotaPilotQueueFullError extends QuotaPilotError {
  constructor(message: string, details?: QuotaPilotErrorDetails) {
    super(message, details);
    this.name = 'QuotaPilotQueueFullError';
  }
}

/**
 * `maxKeys` reached and no key was safe to evict. Refusing is deliberate: the
 * alternative is discarding a partially drained bucket, which hands out free
 * capacity. See docs/GUARANTEES.md, "Key eviction".
 */
export class QuotaPilotKeyLimitError extends QuotaPilotError {
  constructor(message: string, details?: QuotaPilotErrorDetails) {
    super(message, details);
    this.name = 'QuotaPilotKeyLimitError';
  }
}

/** `totalBudgetMs` would be exceeded by the next wait or attempt. */
export class QuotaPilotBudgetError extends QuotaPilotError {
  constructor(message: string, details?: QuotaPilotErrorDetails) {
    super(message, details);
    this.name = 'QuotaPilotBudgetError';
  }
}

/**
 * An attempt exceeded `attemptTimeoutMs` and was not retried.
 *
 * Carries no `cause`: the attempt produced no error, it was abandoned. Whether
 * the remote operation completed is UNKNOWN — that is the whole point of this
 * being its own error class rather than folded into a generic failure.
 */
export class QuotaPilotTimeoutError extends QuotaPilotError {
  /** The timeout that fired, in milliseconds. */
  readonly timeoutMs: number;

  constructor(message: string, info: QuotaPilotErrorDetails & {timeoutMs: number}) {
    super(message, info);
    this.name = 'QuotaPilotTimeoutError';
    this.timeoutMs = info.timeoutMs;
  }
}

/**
 * The caller's `AbortSignal` fired.
 *
 * `name` is `'AbortError'`, not the class name, so it interoperates with the
 * `fetch`/`DOMException` convention that callers already branch on. This is
 * the one place the taxonomy's naming rule is broken on purpose. When the
 * signal carried a `reason`, that is rethrown instead of this class.
 */
export class QuotaPilotAbortError extends QuotaPilotError {
  constructor(message = 'Aborted', details?: QuotaPilotErrorDetails) {
    super(message, details);
    this.name = 'AbortError';
  }
}
