import {describe, expect, it} from 'vitest';

import {BoundedFifo} from '../src/queue.js';

describe('BoundedFifo', () => {
  it('starts empty', () => {
    const queue = new BoundedFifo<string>(3);
    expect(queue.size).toBe(0);
    expect(queue.isEmpty).toBe(true);
    expect(queue.peek()).toBeUndefined();
    expect(queue.dequeue()).toBeUndefined();
  });

  it('preserves insertion order', () => {
    const queue = new BoundedFifo<string>(10);
    for (const item of ['a', 'b', 'c', 'd']) queue.enqueue(item);

    expect(queue.peek()).toBe('a');
    expect([queue.dequeue(), queue.dequeue(), queue.dequeue(), queue.dequeue()]).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(queue.isEmpty).toBe(true);
  });

  it('peek does not remove', () => {
    const queue = new BoundedFifo<string>(2);
    queue.enqueue('only');

    expect(queue.peek()).toBe('only');
    expect(queue.peek()).toBe('only');
    expect(queue.size).toBe(1);
  });

  it('refuses at the bound instead of growing, and reports the refusal', () => {
    const queue = new BoundedFifo<number>(2);

    expect(queue.enqueue(1)).toBe(true);
    expect(queue.enqueue(2)).toBe(true);
    expect(queue.enqueue(3)).toBe(false);
    expect(queue.size).toBe(2);
    // The refused item is not silently dropped into the middle either.
    expect([queue.dequeue(), queue.dequeue()]).toEqual([1, 2]);
  });

  it('accepts again once space is freed', () => {
    const queue = new BoundedFifo<number>(1);
    queue.enqueue(1);
    expect(queue.enqueue(2)).toBe(false);

    queue.dequeue();

    expect(queue.enqueue(2)).toBe(true);
    expect(queue.peek()).toBe(2);
  });

  it('interleaves enqueue and dequeue without reordering', () => {
    const queue = new BoundedFifo<number>(4);
    const seen: number[] = [];

    for (let i = 0; i < 20; i++) {
      queue.enqueue(i);
      if (i % 2 === 1) {
        const next = queue.dequeue();
        if (next !== undefined) seen.push(next);
      }
    }
    while (!queue.isEmpty) {
      const next = queue.dequeue();
      if (next !== undefined) seen.push(next);
    }

    // Everything that was accepted comes out in order, with no duplicates.
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
  });
});
