import {describe, expect, it} from 'vitest';

import {createVirtualClock} from './harness/virtual-clock.js';

describe('virtual clock', () => {
  it('starts at the given time and does not move on its own', async () => {
    const clock = createVirtualClock(1_000);
    expect(clock.now()).toBe(1_000);
    await clock.flush();
    expect(clock.now()).toBe(1_000);
  });

  it('fires a timer at its due time and reports the due time to the callback', async () => {
    const clock = createVirtualClock(0);
    const seen: number[] = [];
    clock.setTimer(() => seen.push(clock.now()), 500);

    await clock.advance(499);
    expect(seen).toEqual([]);

    await clock.advance(1);
    expect(seen).toEqual([500]);
    expect(clock.now()).toBe(500);
  });

  it('does not fire a cancelled timer', async () => {
    const clock = createVirtualClock(0);
    let fired = false;
    const cancel = clock.setTimer(() => {
      fired = true;
    }, 100);

    cancel();
    cancel(); // idempotent
    await clock.advance(1_000);

    expect(fired).toBe(false);
    expect(clock.pendingTimers()).toBe(0);
  });

  // ---------------------------------------------------------------------
  // The three deliberate harness tests. Every later suite depends on these
  // holding, so they are checked before any library code uses the clock.
  // ---------------------------------------------------------------------

  it('HARNESS 1: a timer that resolves a promise whose continuation schedules another timer', async () => {
    // This is the shape of every wait loop in the library. An `advance` that
    // fires due timers without flushing microtasks between them never sees
    // the second timer and hangs here.
    const clock = createVirtualClock(0);
    const order: string[] = [];

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        clock.setTimer(resolve, ms);
      });

    const chain = (async () => {
      await sleep(100);
      order.push(`first@${clock.now()}`);
      await sleep(100);
      order.push(`second@${clock.now()}`);
      await sleep(100);
      order.push(`third@${clock.now()}`);
    })();

    await clock.advance(300);
    await chain;

    expect(order).toEqual(['first@100', 'second@200', 'third@300']);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('HARNESS 2: two timers due at the same instant fire in scheduling order', async () => {
    const clock = createVirtualClock(0);
    const order: string[] = [];
    clock.setTimer(() => order.push('a'), 50);
    clock.setTimer(() => order.push('b'), 50);
    clock.setTimer(() => order.push('c'), 25);

    await clock.advance(50);

    expect(order).toEqual(['c', 'a', 'b']);
  });

  it('HARNESS 3: cancelling from inside another timer prevents the later firing', async () => {
    const clock = createVirtualClock(0);
    const fired: string[] = [];
    let cancelSecond = (): void => {};

    clock.setTimer(() => {
      fired.push('first');
      cancelSecond();
    }, 10);
    cancelSecond = clock.setTimer(() => fired.push('second'), 20);

    await clock.advance(100);

    expect(fired).toEqual(['first']);
  });

  it('advanceToNextTimer jumps exactly to the next due timer', async () => {
    const clock = createVirtualClock(0);
    clock.setTimer(() => {}, 1_234);
    expect(clock.nextTimerAt()).toBe(1_234);

    await clock.advanceToNextTimer();

    expect(clock.now()).toBe(1_234);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('advanceToNextTimer is a no-op when idle', async () => {
    const clock = createVirtualClock(7);
    await clock.advanceToNextTimer();
    expect(clock.now()).toBe(7);
  });

  it('runAll drains a chain of timers scheduled by earlier timers', async () => {
    const clock = createVirtualClock(0);
    let remaining = 5;
    const reschedule = (): void => {
      if (--remaining > 0) clock.setTimer(reschedule, 1_000);
    };
    clock.setTimer(reschedule, 1_000);

    await clock.runAll();

    expect(remaining).toBe(0);
    expect(clock.now()).toBe(5_000);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('runAll fails loudly instead of hanging on an endlessly rescheduling timer', async () => {
    const clock = createVirtualClock(0);
    const loop = (): void => {
      clock.setTimer(loop, 1);
    };
    clock.setTimer(loop, 1);

    await expect(clock.runAll()).rejects.toThrow(/kept rescheduling/);
  });

  it('treats a zero or negative delay as due at the current instant', async () => {
    const clock = createVirtualClock(100);
    const seen: number[] = [];
    clock.setTimer(() => seen.push(clock.now()), 0);
    clock.setTimer(() => seen.push(clock.now()), -5);

    await clock.advance(0);

    expect(seen).toEqual([100, 100]);
  });
});
