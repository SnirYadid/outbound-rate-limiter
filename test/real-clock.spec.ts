/**
 * The one suite that uses real time.
 *
 * Everything else in the project runs on the virtual clock. `realClock` is the
 * seam between the library and the platform, so verifying it necessarily means
 * letting a real timer fire. Kept to a handful of milliseconds, and kept in its
 * own file so "no test sleeps" remains true of every other suite.
 */

import {describe, expect, it} from 'vitest';

import {realClock} from '../src/time.js';
import {defaultRandom} from '../src/random.js';

describe('realClock', () => {
  it('reports a positive, wall-clock-comparable reading', () => {
    const reading = realClock.now();
    expect(Number.isFinite(reading)).toBe(true);
    // Comparable to Date.now() rather than process-relative, so an event
    // timestamp can be correlated with an ordinary log line.
    expect(Math.abs(reading - Date.now())).toBeLessThan(60_000);
  });

  it('is monotonic across rapid successive reads', () => {
    let previous = realClock.now();
    for (let i = 0; i < 2_000; i++) {
      const current = realClock.now();
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it('fires a timer and reports elapsed time through now()', async () => {
    const start = realClock.now();
    await new Promise<void>((resolve) => {
      realClock.setTimer(resolve, 5);
    });
    expect(realClock.now() - start).toBeGreaterThanOrEqual(1);
  });

  it('cancels a pending timer, idempotently', async () => {
    let fired = false;
    const cancel = realClock.setTimer(() => {
      fired = true;
    }, 5);

    cancel();
    cancel();

    await new Promise<void>((resolve) => {
      realClock.setTimer(resolve, 25);
    });
    expect(fired).toBe(false);
  });
});

describe('defaultRandom', () => {
  it('draws within [0, 1)', () => {
    for (let i = 0; i < 1_000; i++) {
      const value = defaultRandom();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
