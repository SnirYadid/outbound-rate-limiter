/** A promise whose settlement the test controls. Test-only. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  /** Takes no argument when `T` is `void`, so `gate.resolve()` typechecks. */
  resolve(...args: [T] extends [void] ? [] : [T]): void;
  reject(error: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The cast is confined to this one line: the executor's `resolve` accepts a
  // value or a thenable, while `Deferred` presents the no-argument form when
  // `T` is `void`. Both describe the same function.
  return {promise, resolve, reject} as unknown as Deferred<T>;
}

/**
 * Swallows a rejection so an expected failure cannot surface as an unhandled
 * rejection and fail an unrelated test.
 */
export function ignore(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    () => undefined
  );
}
