/* The engine events waiting to become audible. The worklet stamps each with the engine frame it sounds at; the visuals
   loop takes them out as the clock passes. Bounded, because the loop stops while the page is hidden and the queue must
   not grow without limit meanwhile (and a pile of old events must not flood the first frame back). */
import type { EngineEvent } from "../lib/contract.ts";

/** Most events held. Past it the oldest go: a display that is that far behind does not need them. */
export const EVENT_QUEUE_MAX = 2000;

export class EventQueue {
  private items: EngineEvent[] = [];

  get length(): number {
    return this.items.length;
  }

  /** Add events (copies), oldest first; the oldest are dropped when the bound is passed. */
  push(events: readonly EngineEvent[]): void {
    for (const e of events) {
      this.items.push({ ...e });
    }
    if (this.items.length > EVENT_QUEUE_MAX) {
      this.items.splice(0, this.items.length - EVENT_QUEUE_MAX);
    }
  }

  /** Remove and return the events whose frame has come (`frame <= now`), in order. */
  takeDue(now: number): EngineEvent[] {
    let n = 0;
    while (n < this.items.length && (this.items[n]?.frame ?? 0) <= now) {
      n += 1;
    }
    return n > 0 ? this.items.splice(0, n) : [];
  }

  clear(): void {
    this.items = [];
  }
}
