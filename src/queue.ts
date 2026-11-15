/**
 * A bounded FIFO.
 *
 * Unbounded queueing turns a slow provider into unbounded memory, which is why
 * the bound is a constructor argument rather than an option someone can forget
 * to set. `enqueue` reports refusal rather than throwing, so the caller decides
 * what a full queue means.
 *
 * Dequeue is `Array.prototype.shift`, which is O(n). With the default bound of
 * 1024 entries per key that is irrelevant, and an index-based ring buffer would
 * be an optimisation with no measurement behind it.
 */
export class BoundedFifo<T> {
  private readonly items: T[] = [];

  constructor(private readonly maxDepth: number) {}

  /** Adds to the back. Returns `false` when the queue is at its bound. */
  enqueue(item: T): boolean {
    if (this.items.length >= this.maxDepth) return false;
    this.items.push(item);
    return true;
  }

  /** The front item, without removing it. */
  peek(): T | undefined {
    return this.items[0];
  }

  /** Removes and returns the front item. */
  dequeue(): T | undefined {
    return this.items.shift();
  }

  get size(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }
}
