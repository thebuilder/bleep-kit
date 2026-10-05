/* Files mode has no engine to emit note events, so the player replays the song's `.events.json` against the time
   its source started. Positions are seconds into the rendered file (intro, then one loop section, then the tail);
   a looping source repeats the events of [loopStart, loopEnd) and the replayer follows it. */

import type { EngineEvent } from "@bleepkit/core";
import type { LoopPlan } from "./schedule.ts";
import type { PlayerEvent } from "./types.ts";

export interface EventsFile {
  events: EngineEvent[];
  sampleRate: number;
}

const EVENT_TYPES = new Set([
  "noteOn",
  "noteOff",
  "trigger",
  "row",
  "loop",
  "end",
]);

function isEvent(value: unknown): value is EngineEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const e = value as Record<string, unknown>;
  return (
    typeof e.type === "string" &&
    EVENT_TYPES.has(e.type) &&
    typeof e.frame === "number"
  );
}

/** Accepts the bare event array of a render, or `{ sampleRate, events }`. Anything else yields null. */
export function parseEventsFile(
  json: unknown,
  fallbackRate: number
): EventsFile | null {
  let list: unknown;
  let rate = fallbackRate;
  if (Array.isArray(json)) {
    list = json;
  } else if (typeof json === "object" && json !== null) {
    const o = json as Record<string, unknown>;
    list = o.events;
    if (typeof o.sampleRate === "number" && o.sampleRate > 0) {
      rate = o.sampleRate;
    }
  }
  if (!Array.isArray(list)) {
    return null;
  }
  const events = list.filter(isEvent);
  return { events, sampleRate: rate };
}

export interface ReplayStart {
  /** The context's sample rate, for the frame of the events it emits. */
  contextRate: number;
  /** Length of the decoded buffer in seconds. */
  duration: number;
  /** Seconds between rendering and hearing, added to every time. */
  latency: number;
  /** Seconds into the file the source starts from. */
  offset: number;
  /** AudioContext time the source was started at (when it is rendered). */
  startTime: number;
}

interface Timed {
  event: EngineEvent;
  position: number;
}

/** Walks the events of one playing song. `collect(now)` returns what became audible up to `now`, in order. */
export class EventReplayer {
  private readonly timed: Timed[];
  private readonly plan: LoopPlan;
  private readonly start: ReplayStart;
  private pass = 0;
  private index = 0;
  private state: "playing" | "finished" = "playing";
  private readonly firstEnd: number;
  private readonly sectionLength: number;

  constructor(file: EventsFile, plan: LoopPlan, start: ReplayStart) {
    this.plan = plan;
    this.start = start;
    this.timed = file.events
      .filter((e) => e.type !== "loop" && e.type !== "end")
      .map((event) => ({ event, position: event.frame / file.sampleRate }))
      .sort((a, b) => a.position - b.position);
    this.sectionLength = plan.loopEnd - plan.loopStart;
    this.firstEnd = plan.loop ? plan.loopEnd : start.duration;
    this.index = this.firstIndex();
  }

  get done(): boolean {
    return this.state === "finished";
  }

  /** Audible time of the first event after `from` seconds into the file in pass 0. */
  private firstIndex(): number {
    const i = this.timed.findIndex((t) => t.position >= this.start.offset);
    return i === -1 ? this.timed.length : i;
  }

  /** Time at which pass `k` begins (k = 0 is the start of the source). */
  private passStart(k: number): number {
    const base = this.start.startTime + this.start.latency;
    if (k === 0) {
      return base - this.start.offset;
    }
    return (
      base +
      (this.plan.loopEnd - this.start.offset) +
      (k - 1) * this.sectionLength -
      this.plan.loopStart
    );
  }

  private timeOf(position: number): number {
    return this.passStart(this.pass) + position;
  }

  private make(
    base: EngineEvent,
    type: EngineEvent["type"],
    time: number
  ): PlayerEvent {
    return {
      ...base,
      frame: Math.round(time * this.start.contextRate),
      time,
      type,
    };
  }

  private blank(type: EngineEvent["type"]): EngineEvent {
    return {
      channel: -1,
      channelId: "",
      frame: 0,
      hz: 0,
      id: "",
      note: 0,
      order: -1,
      row: -1,
      type,
      velocity: 0,
    };
  }

  private enterLoopPass(): void {
    const i = this.timed.findIndex((t) => t.position >= this.plan.loopStart);
    this.index = i === -1 ? this.timed.length : i;
  }

  collect(now: number): PlayerEvent[] {
    const out: PlayerEvent[] = [];
    const looping = this.plan.loop && this.sectionLength > 0;
    // an overslept loop (a background tab) skips whole passes instead of replaying them
    if (looping) {
      const firstWrap =
        this.start.startTime +
        this.start.latency +
        (this.plan.loopEnd - this.start.offset);
      const target = 1 + Math.floor((now - firstWrap) / this.sectionLength);
      if (now >= firstWrap && target - this.pass > 2) {
        this.pass = target;
        this.enterLoopPass();
        out.push(this.loopEvent());
      }
    }
    while (this.state === "playing") {
      const next = this.timed[this.index];
      const limit = this.passLimit();
      if (next && next.position < limit) {
        const time = this.timeOf(next.position);
        if (time > now) {
          break;
        }
        out.push(this.make(next.event, next.event.type, time));
        this.index += 1;
        continue;
      }
      // this pass has no more events: the pass boundary comes next
      const boundary = this.timeOf(limit);
      if (boundary > now) {
        break;
      }
      if (looping) {
        this.pass += 1;
        this.enterLoopPass();
        out.push(this.loopEvent());
      } else {
        this.state = "finished";
        out.push(this.make(this.blank("end"), "end", boundary));
      }
    }
    return out;
  }

  private loopEvent(): PlayerEvent {
    return this.make(
      this.blank("loop"),
      "loop",
      this.timeOf(this.plan.loopStart)
    );
  }

  private passLimit(): number {
    return this.pass === 0 ? this.firstEnd : this.plan.loopEnd;
  }
}
