/**
 * WakeQueue
 *
 * A simple async FIFO queue for daemon wake events.
 * Fixes: rapid-fire pushes no longer drop resolvers — uses an array of resolvers
 * with a while-loop drain in `next()`.
 */

import type { WakeReason } from './prompts.js';

export type WakeEvent = WakeReason & { queuedAt: Date };

export class WakeQueue {
  private queue: WakeEvent[] = [];
  private resolvers: Array<() => void> = [];

  push(event: WakeReason): void {
    this.queue.push({ ...event, queuedAt: new Date() });
    // Notify the first waiter if any
    const resolve = this.resolvers.shift();
    if (resolve) resolve();
  }

  async next(): Promise<WakeEvent> {
    // Drain loop: re-check the queue after the promise resolves to handle
    // rapid-fire pushes that arrive between promise creation and resolution.
    while (this.queue.length === 0) {
      await new Promise<void>((resolve) => {
        this.resolvers.push(resolve);
      });
    }
    return this.queue.shift()!;
  }

  get length(): number {
    return this.queue.length;
  }
}
