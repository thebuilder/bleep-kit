import type { EngineEvent } from "@bleepkit/core";
import { describe, expect, it } from "vitest";
import { EventDispatcher } from "../src/dispatcher.ts";
import { EventReplayer, parseEventsFile } from "../src/event-replay.ts";
import { planLoop } from "../src/schedule.ts";
import type { PlayerEvent } from "../src/types.ts";

const RATE = 48_000;

function ev(
  type: EngineEvent["type"],
  seconds: number,
  extra: Partial<EngineEvent> = {}
): EngineEvent {
  return {
    channel: 0,
    channelId: "pulse1",
    frame: Math.round(seconds * RATE),
    hz: 440,
    id: "lead",
    note: 69,
    order: -1,
    row: -1,
    type,
    velocity: 1,
    ...extra,
  };
}

const start = (over: Partial<Parameters<typeof makeStart>[0]> = {}) =>
  makeStart(over);
function makeStart(
  over: {
    startTime?: number;
    offset?: number;
    latency?: number;
    duration?: number;
  } = {}
) {
  return {
    contextRate: 44_100,
    duration: 10,
    latency: 0.02,
    offset: 0,
    startTime: 5,
    ...over,
  };
}

const times = (list: PlayerEvent[]) =>
  list.map((e) => [e.type, Number(e.time.toFixed(4))]);

describe("parseEventsFile", () => {
  it("takes the bare array of a render or an object with the rate", () => {
    const list = [
      ev("noteOn", 1),
      ev("row", 2, { id: "intro", order: 0, row: 4 }),
    ];
    expect(parseEventsFile(list, RATE)).toEqual({
      events: list,
      sampleRate: RATE,
    });
    expect(parseEventsFile({ events: list, sampleRate: 44_100 }, RATE)).toEqual(
      { events: list, sampleRate: 44_100 }
    );
    expect(
      parseEventsFile({ events: list, sampleRate: -1 }, RATE)?.sampleRate
    ).toBe(RATE);
  });

  it("drops entries that are not events and rejects other shapes", () => {
    const good = ev("noteOn", 1);
    expect(
      parseEventsFile(
        [good, null, 4, { frame: 1, type: "nope" }, { type: "noteOn" }],
        RATE
      )?.events
    ).toEqual([good]);
    expect(parseEventsFile(null, RATE)).toBeNull();
    expect(parseEventsFile("x", RATE)).toBeNull();
    expect(parseEventsFile({ events: "x" }, RATE)).toBeNull();
  });
});

describe("EventReplayer without a loop", () => {
  const plan = planLoop({ loopEnd: null, loopStart: null }, 10);
  const file = {
    events: [
      ev("noteOn", 1),
      ev("noteOff", 1.5),
      ev("loop", 0),
      ev("noteOn", 3),
      ev("end", 10),
    ],
    sampleRate: RATE,
  };

  it("releases events at source start + position + latency, and nothing early", () => {
    const r = new EventReplayer(file, plan, start());
    expect(r.collect(5)).toEqual([]);
    expect(r.collect(6.01)).toEqual([]);
    expect(times(r.collect(6.03))).toEqual([["noteOn", 6.02]]);
    expect(times(r.collect(7))).toEqual([["noteOff", 6.52]]);
    expect(times(r.collect(8.5))).toEqual([["noteOn", 8.02]]);
  });

  it("emits its own end at the end of the buffer and then stays done", () => {
    const r = new EventReplayer(file, plan, start());
    r.collect(9);
    expect(r.done).toBe(false);
    expect(times(r.collect(15.5))).toEqual([["end", 15.02]]);
    expect(r.done).toBe(true);
    expect(r.collect(100)).toEqual([]);
  });

  it("delivers a burst in order when the timer was late", () => {
    const r = new EventReplayer(file, plan, start());
    expect(times(r.collect(100))).toEqual([
      ["noteOn", 6.02],
      ["noteOff", 6.52],
      ["noteOn", 8.02],
      ["end", 15.02],
    ]);
  });

  it("starts from an offset: earlier events are skipped and times shift", () => {
    const r = new EventReplayer(file, plan, start({ offset: 1.2 }));
    expect(times(r.collect(100))).toEqual([
      ["noteOff", 5.32],
      ["noteOn", 6.82],
      ["end", 13.82],
    ]);
  });

  it("stamps the frame in the context's sample rate", () => {
    const r = new EventReplayer(file, plan, start());
    const [first] = r.collect(7);
    expect(first?.frame).toBe(Math.round(6.02 * 44_100));
    expect(first?.hz).toBe(440);
  });

  it("ignores events beyond the buffer", () => {
    const r = new EventReplayer(
      { events: [ev("noteOn", 12)], sampleRate: RATE },
      plan,
      start()
    );
    expect(times(r.collect(100))).toEqual([["end", 15.02]]);
  });
});

describe("EventReplayer on a looping source", () => {
  // intro 0..2, loop 2..4, tail 4..6 (never heard while looping)
  const plan = planLoop({ loopEnd: 4, loopStart: 2 }, 6);
  const file = {
    events: [
      ev("noteOn", 0.5),
      ev("noteOn", 2.5),
      ev("noteOn", 3.5),
      ev("noteOn", 4.5),
      ev("loop", 2),
      ev("end", 6),
    ],
    sampleRate: RATE,
  };

  it("plays the intro once, then repeats the loop section with a loop event at each wrap", () => {
    const r = new EventReplayer(file, plan, start({ duration: 6, latency: 0 }));
    expect(times(r.collect(5 + 4.2))).toEqual([
      ["noteOn", 5.5],
      ["noteOn", 7.5],
      ["noteOn", 8.5],
      ["loop", 9],
    ]);
    expect(times(r.collect(5 + 6.2))).toEqual([
      ["noteOn", 9.5],
      ["noteOn", 10.5],
      ["loop", 11],
    ]);
    expect(times(r.collect(5 + 8.2))).toEqual([
      ["noteOn", 11.5],
      ["noteOn", 12.5],
      ["loop", 13],
    ]);
    expect(r.done).toBe(false);
  });

  it("never replays the tail beyond the loop end", () => {
    const r = new EventReplayer(file, plan, start({ duration: 6, latency: 0 }));
    const heard: number[] = [];
    for (let now = 5; now <= 5 + 10.2; now += 0.25) {
      for (const e of r.collect(now)) {
        if (e.type === "noteOn") {
          heard.push(Number(e.time.toFixed(4)));
        }
      }
    }
    // the intro note once, then the two loop notes every 2 s; the note at 4.5 s is in the tail and never plays
    expect(heard).toEqual([5.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5, 13.5, 14.5]);
  });

  it("starting inside the loop begins at the offset and wraps at the loop end", () => {
    const r = new EventReplayer(
      file,
      plan,
      start({ duration: 6, latency: 0, offset: 3 })
    );
    expect(times(r.collect(5 + 2.2))).toEqual([
      ["noteOn", 5.5],
      ["loop", 6],
      ["noteOn", 6.5],
    ]);
  });

  it("skips whole passes after a long sleep instead of replaying them", () => {
    const r = new EventReplayer(file, plan, start({ duration: 6, latency: 0 }));
    const out = r.collect(5 + 3600.3);
    expect(out.length).toBeLessThan(8);
    expect(out.every((e) => e.time <= 5 + 3600.3)).toBe(true);
    expect(out.some((e) => e.type === "loop")).toBe(true);
    // the next pass continues in step with the audio: wraps stay on the 2 s grid
    const next = r.collect(5 + 3604);
    const loops = next
      .filter((e) => e.type === "loop")
      .map((e) => (e.time - 5 - 4) % 2);
    expect(
      loops.every((m) => Math.abs(m) < 1e-6 || Math.abs(m - 2) < 1e-6)
    ).toBe(true);
  });
});

describe("EventDispatcher", () => {
  const event = (
    type: PlayerEvent["type"],
    time: number,
    id = ""
  ): PlayerEvent => ({ ...ev(type, 0), id, time });

  it("calls listeners when an event's time arrives, in time order", () => {
    const d = new EventDispatcher(() => undefined);
    const seen: string[] = [];
    d.on("noteOn", (e) => seen.push(`on:${e.id}`));
    d.on("row", (e) => seen.push(`row:${e.id}`));
    d.push(event("noteOn", 3, "c"));
    d.push(event("noteOn", 1, "a"));
    d.push(event("row", 2, "b"));
    expect(d.pending).toBe(3);
    d.flush(0.5);
    expect(seen).toEqual([]);
    d.flush(2);
    expect(seen).toEqual(["on:a", "row:b"]);
    d.flush(10);
    expect(seen).toEqual(["on:a", "row:b", "on:c"]);
    expect(d.pending).toBe(0);
  });

  it("drops events nobody listens for and stops calling unsubscribed listeners", () => {
    const d = new EventDispatcher(() => undefined);
    d.push(event("noteOn", 1));
    expect(d.pending).toBe(0);
    let n = 0;
    const off = d.on("noteOn", () => {
      n += 1;
    });
    expect(d.wants("noteOn")).toBe(true);
    d.push(event("noteOn", 1));
    d.flush(1);
    off();
    expect(d.wants("noteOn")).toBe(false);
    d.push(event("noteOn", 2));
    d.flush(5);
    expect(n).toBe(1);
  });

  it("reports a throwing listener and keeps delivering", () => {
    const errors: string[] = [];
    const d = new EventDispatcher((e) => errors.push(e.message));
    let reached = false;
    d.on("end", () => {
      throw new Error("boom");
    });
    d.on("end", () => {
      reached = true;
    });
    d.push(event("end", 0));
    d.flush(1);
    expect(errors).toEqual(["boom"]);
    expect(reached).toBe(true);
  });

  it("clears and disposes", () => {
    const d = new EventDispatcher(() => undefined);
    d.on("end", () => undefined);
    d.push(event("end", 9));
    d.clear();
    expect(d.pending).toBe(0);
    d.dispose();
    expect(d.wants("end")).toBe(false);
  });
});
