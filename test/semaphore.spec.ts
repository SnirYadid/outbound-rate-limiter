import {describe, expect, it} from 'vitest';

import {createSemaphore} from '../src/semaphore.js';

describe('semaphore', () => {
  it('hands out up to capacity and then refuses without side effects', () => {
    const semaphore = createSemaphore(2);

    const first = semaphore.tryAcquire();
    const second = semaphore.tryAcquire();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(semaphore.inFlight).toBe(2);

    // A refusal must change nothing — the counter stays put, so a caller can
    // safely attempt and fall back.
    expect(semaphore.tryAcquire()).toBeNull();
    expect(semaphore.tryAcquire()).toBeNull();
    expect(semaphore.inFlight).toBe(2);
  });

  it('frees a slot on release', () => {
    const semaphore = createSemaphore(1);
    const release = semaphore.tryAcquire();
    expect(semaphore.tryAcquire()).toBeNull();

    release?.();

    expect(semaphore.inFlight).toBe(0);
    expect(semaphore.tryAcquire()).not.toBeNull();
  });

  it('NEVER releases a slot twice', () => {
    // Double release would inflate capacity, which is the one mistake a
    // semaphore must not make.
    const semaphore = createSemaphore(1);
    const release = semaphore.tryAcquire();

    release?.();
    release?.();
    release?.();

    expect(semaphore.inFlight).toBe(0);
    expect(semaphore.tryAcquire()).not.toBeNull();
    expect(semaphore.tryAcquire()).toBeNull();
  });

  it('treats each handle as owning only the slot it took', () => {
    const semaphore = createSemaphore(2);
    const a = semaphore.tryAcquire();
    const b = semaphore.tryAcquire();

    a?.();
    a?.();
    expect(semaphore.inFlight).toBe(1);

    b?.();
    expect(semaphore.inFlight).toBe(0);
  });

  it('wakes waiters in FIFO order, and stops once capacity is taken', () => {
    const semaphore = createSemaphore(1);
    const release = semaphore.tryAcquire();
    const woken: string[] = [];
    const taken: (() => void)[] = [];

    // Realistic waiters: each one acquires when woken, which is what a pump
    // does. Only the first can succeed, so the drain must stop there.
    for (const name of ['a', 'b', 'c']) {
      semaphore.waitForRelease(() => {
        woken.push(name);
        const mine = semaphore.tryAcquire();
        if (mine !== null) taken.push(mine);
      });
    }
    expect(semaphore.waiting).toBe(3);

    release?.();

    expect(woken).toEqual(['a']);
    expect(taken).toHaveLength(1);
    expect(semaphore.waiting).toBe(2);
  });

  it('keeps draining past a waiter that declines the slot', () => {
    // A woken pump may find it cannot use the slot after all. The drain must
    // move on to the next waiter rather than stalling, or that freed slot is
    // lost until something else happens to release.
    const semaphore = createSemaphore(3);
    const held = [semaphore.tryAcquire(), semaphore.tryAcquire(), semaphore.tryAcquire()];
    const woken: string[] = [];

    for (const name of ['a', 'b', 'c']) {
      semaphore.waitForRelease(() => {
        woken.push(name);
      });
    }

    held[0]?.();
    held[1]?.();

    expect(woken).toEqual(['a', 'b', 'c']);
    expect(semaphore.waiting).toBe(0);
  });

  it('survives a waiter that releases during its own wake-up', () => {
    // Re-entrant release inside the drain loop: the guard stops the nested
    // drain, and the outer loop picks the freed slot up on its next pass.
    const semaphore = createSemaphore(1);
    const first = semaphore.tryAcquire();
    const order: string[] = [];

    semaphore.waitForRelease(() => {
      order.push('a');
      const mine = semaphore.tryAcquire();
      mine?.(); // releases re-entrantly, from inside drain
    });
    semaphore.waitForRelease(() => {
      order.push('b');
    });

    first?.();

    expect(order).toEqual(['a', 'b']);
    expect(semaphore.inFlight).toBe(0);
  });

  it('never admits more than capacity under interleaved acquire and release', () => {
    const semaphore = createSemaphore(4);
    const held: (() => void)[] = [];
    let peak = 0;

    // A deterministic interleaving: take three, give one back, repeat.
    for (let round = 0; round < 50; round++) {
      for (let i = 0; i < 3; i++) {
        const release = semaphore.tryAcquire();
        if (release !== null) held.push(release);
        peak = Math.max(peak, semaphore.inFlight);
        expect(semaphore.inFlight).toBeLessThanOrEqual(4);
      }
      held.shift()?.();
    }

    expect(peak).toBe(4);
  });

  it('treats Infinity capacity as no limit', () => {
    const semaphore = createSemaphore(Infinity);
    for (let i = 0; i < 1_000; i++) {
      expect(semaphore.tryAcquire()).not.toBeNull();
    }
    expect(semaphore.inFlight).toBe(1_000);
    expect(semaphore.capacity).toBe(Infinity);
  });
});
