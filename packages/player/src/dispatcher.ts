/* Delivers PlayerEvents to listeners when they become audible. Events are queued with their audible time and
   released by `flush(now)`, which the player calls from a short timer against the AudioContext clock. */

import type { PlayerEvent, PlayerEventType } from "./types.ts";

type Listener = (e: PlayerEvent) => void;

export class EventDispatcher {
  private readonly listeners = new Map<PlayerEventType, Set<Listener>>();
  private queue: PlayerEvent[] = [];
  private readonly report: (error: Error) => void;

  constructor(report: (error: Error) => void) {
    this.report = report;
  }

  on(type: PlayerEventType, fn: Listener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  wants(type: PlayerEventType): boolean {
    return (this.listeners.get(type)?.size ?? 0) > 0;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Queue an event for its `time`. Events nobody listens for are dropped at once. */
  push(e: PlayerEvent): void {
    if (!this.wants(e.type)) {
      return;
    }
    let at = this.queue.length;
    while (at > 0 && (this.queue[at - 1]?.time ?? 0) > e.time) {
      at -= 1;
    }
    this.queue.splice(at, 0, e);
  }

  /** Call listeners for every queued event whose time is at or before `now`. */
  flush(now: number): void {
    let due = 0;
    while (due < this.queue.length && (this.queue[due]?.time ?? 0) <= now) {
      due += 1;
    }
    if (due === 0) {
      return;
    }
    const ready = this.queue.slice(0, due);
    this.queue = this.queue.slice(due);
    for (const e of ready) {
      this.deliver(e);
    }
  }

  clear(): void {
    this.queue = [];
  }

  /** Immediately, without queueing. */
  private deliver(e: PlayerEvent): void {
    for (const fn of [...(this.listeners.get(e.type) ?? [])]) {
      try {
        fn(e);
      } catch (error) {
        this.report(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  dispose(): void {
    this.queue = [];
    this.listeners.clear();
  }
}
