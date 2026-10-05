/* Engine events for visuals (section 4.1): a preallocated ring of reused EngineEvent objects. process() appends the
   events of a block to the caller's array; the caller must copy anything it keeps. */

import type { EngineEvent, EngineEventType } from "../types.ts";

const EVENT_RING = 512;

export class EventRing {
  private readonly ring: EngineEvent[] = [];
  private head = 0;
  private pending = 0;

  constructor() {
    for (let i = 0; i < EVENT_RING; i += 1) {
      this.ring.push({
        channel: -1,
        channelId: "",
        frame: 0,
        hz: 0,
        id: "",
        note: 0,
        order: -1,
        row: -1,
        type: "noteOn",
        velocity: 0,
      });
    }
  }

  push(
    type: EngineEventType,
    frame: number,
    channel: number,
    channelId: string,
    note: number,
    hz: number,
    velocity: number,
    id: string,
    order: number,
    row: number
  ): void {
    const e = this.ring[this.head];
    if (!e) {
      return;
    }
    e.type = type;
    e.frame = frame;
    e.channel = channel;
    e.channelId = channelId;
    e.note = note;
    e.hz = hz;
    e.velocity = velocity;
    e.id = id;
    e.order = order;
    e.row = row;
    this.head = (this.head + 1) % EVENT_RING;
    if (this.pending < EVENT_RING) {
      this.pending += 1;
    }
  }

  /** Append the pending events (oldest first) to out and clear. */
  drain(out: EngineEvent[]): void {
    let idx = (this.head - this.pending + EVENT_RING) % EVENT_RING;
    for (let i = 0; i < this.pending; i += 1) {
      const e = this.ring[idx];
      if (e) {
        out.push(e);
      }
      idx = (idx + 1) % EVENT_RING;
    }
    this.pending = 0;
  }
}
