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
    // audible at 6.02 s on a 44.1 kHz context: frame 265 482
    expect(first?.frame).toBe(265_482);
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
    // an hour asleep: the 2 s loop passes began at 9 s (every odd second); the latest wrap at 3605 s is the only
    // thing worth reporting, and nothing of the 1800 passes in between is replayed
    expect(times(r.collect(5 + 3600.3))).toEqual([["loop", 3605]]);
    // and the replay carries on in step with the audio: notes at +0.5 s and +1.5 s of each pass, wraps every 2 s
    expect(times(r.collect(5 + 3604))).toEqual([
      ["noteOn", 3605.5],
      ["noteOn", 3606.5],
      ["loop", 3607],
      ["noteOn", 3607.5],
      ["noteOn", 3608.5],
      ["loop", 3609],
    ]);
  });

  it("plays an event at the loop start in every pass and never one at the loop end", () => {
    // the buffer jumps from the loop end back to the loop start, so the sample at the end is never played
    const edges = {
      events: [ev("noteOn", 2), ev("noteOn", 4)],
      sampleRate: RATE,
    };
    const r = new EventReplayer(
      edges,
      plan,
      start({ duration: 6, latency: 0 })
    );
    // polled every quarter second like the player's timer, so no pass is slept through
    const heard: PlayerEvent[] = [];
    for (let now = 5; now <= 5 + 8.2; now += 0.25) {
      heard.push(...r.collect(now));
    }
    expect(heard.filter((e) => e.type === "noteOn").map((e) => e.time)).toEqual(
      [7, 9, 11, 13]
    );
    expect(heard.filter((e) => e.type === "loop").map((e) => e.time)).toEqual([
      9, 11, 13,
    ]);
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

  it("delivers events with the same time in the order they were queued", () => {
    const d = new EventDispatcher(() => undefined);
    const seen: string[] = [];
    d.on("noteOff", (e) => seen.push(`off:${e.id}`));
    d.on("noteOn", (e) => seen.push(`on:${e.id}`));
    d.push(event("noteOff", 1, "a"));
    d.push(event("noteOn", 1, "b"));
    d.push(event("noteOff", 1, "c"));
    d.flush(1);
    expect(seen).toEqual(["off:a", "on:b", "off:c"]);
  });

  it("is not disturbed by listeners that subscribe or unsubscribe while being called", () => {
    const d = new EventDispatcher(() => undefined);
    const seen: string[] = [];
    const offA = d.on("row", () => {
      seen.push("A");
      offA();
      d.on("row", () => seen.push("late"));
    });
    d.on("row", () => seen.push("B"));
    d.push(event("row", 1));
    d.push(event("row", 2));
    d.flush(5);
    // A leaves and a new listener arrives during the first event: B is not skipped, and the newcomer waits for the
    // next event instead of hearing the one being delivered
    expect(seen).toEqual(["A", "B", "B", "late"]);
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
