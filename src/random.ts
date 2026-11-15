/**
 * The randomness seam.
 *
 * This is the ONLY module in `src/` permitted to name `Math.random`. Jitter is
 * the one place QuotaPilot is non-deterministic, so it is injected and can be
 * replaced wholesale in tests.
 */

/** Returns a value in `[0, 1)`. */
export type RandomFn = () => number;

export const defaultRandom: RandomFn = () => Math.random();

/**
 * A small seeded generator, for tests that need reproducible jitter.
 *
 * This is mulberry32: a 32-bit state, one multiply-xor-shift round per draw.
 * It is not cryptographic and makes no claim to be — the only requirement is
 * that the same seed yields the same sequence on every run and every platform.
 */
export function createSeededRandom(seed: number): RandomFn {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
