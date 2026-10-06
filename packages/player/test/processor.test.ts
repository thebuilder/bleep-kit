import type { EngineEvent, Song } from "@bleepkit/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BleepkitEngine,
  CLOCK_FRAMES,
  type ClockMessage,
  type EngineOptions,
} from "../src/worklet/engine.ts";
import { FakePort } from "./fake-port.ts";
import {
  type FakeSynth,
  type FakeSynthOptions,
  fakeSynthFactory,
} from "./fake-synth.ts";

const RATE = 48_000;

function setup(
  synthOpts: FakeSynthOptions = {},
  options: EngineOptions = {},
  now: (() => number) | null = null
) {
  const port = new FakePort();
  const factory = fakeSynthFactory(synthOpts);
  const time = { value: 10 };
  const engine = new BleepkitEngine(
    port,
    {
      createSynth: factory.create,
      currentTime: () => time.value,
      now,
      sampleRate: RATE,
    },
    options
  );
  const synth = (): FakeSynth => {
    const [s] = factory.made;
    if (!s) {
      throw new Error("no synth was created");
    }
    return s;
  };
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  const block = () => {
    const result = engine.process([[left, right]]);
    time.value += 128 / RATE;
    return result;
  };
  return { block, engine, left, port, right, synth, time };
}

const song = { name: "s" } as unknown as Song;

describe("processor: startup and messages", () => {
  it("creates the synth at the context rate and posts ready", () => {
    const t = setup({}, { scopeFrames: 1024, sfxVoices: 4 });
    expect(t.synth().created).toEqual({
      sampleRate: RATE,
      scopeFrames: 1024,
      sfxVoices: 4,
    });
    expect(t.port.of("ready")).toEqual([{ sampleRate: RATE, type: "ready" }]);
  });

  it("forwards every message type to the synth with its arguments", () => {
    const t = setup();
    const send = (m: unknown) => t.engine.handleMessage(m);
    const lead = { name: "lead" };
    send({ instruments: { lead }, song, type: "loadSong" });
    send({ type: "unloadSong" });
    send({ id: "coin", sfx: { name: "coin" }, type: "loadSfx" });
    send({ id: "coin", type: "unloadSfx" });
    send({ loop: true, order: 1, row: 2, type: "play" });
    send({ type: "pause" });
    send({ type: "stop" });
    send({ order: 3, row: 4, type: "seek" });
    send({
      channel: 1,
      instrument: "lead",
      note: 60,
      type: "noteOn",
      velocity: 0.5,
    });
    send({ channel: 1, type: "noteOff" });
    send({ id: "lead", instrument: lead, type: "setInstrument" });
    send({ channel: 2, muted: true, type: "setChannel", volume: 0.3 });
    send({ limiter: false, type: "setMaster" });
    send({ tempo: 140, type: "setTempo" });
    expect(t.synth().calls).toEqual([
      ["loadSong", song, { lead }],
      ["unloadSong"],
      ["loadSfx", "coin", { name: "coin" }],
      ["unloadSfx", "coin"],
      ["play", { loop: true, order: 1, row: 2 }],
      ["pause"],
      ["stop"],
      ["seek", 3, 4],
      ["noteOn", 1, 60, 0.5, "lead"],
      ["noteOff", 1],
      ["setInstrument", "lead", lead],
      ["setChannel", 2, { muted: true, volume: 0.3 }],
      ["setMaster", { limiter: false }],
      ["setTempo", 140],
    ]);
    expect(t.port.of("error")).toEqual([]);
  });

  it("leaves absent options out of play, trigger and noteOn", () => {
    const t = setup();
    t.engine.handleMessage({ type: "play" });
    t.engine.handleMessage({ handle: 1, id: "a", type: "trigger" });
    t.engine.handleMessage({
      channel: 0,
      note: 60,
      type: "noteOn",
      velocity: 1,
    });
    const { calls } = t.synth();
    expect(calls[0]).toEqual(["play", {}]);
    expect(calls[1]).toEqual(["trigger", "a", {}]);
    expect(calls[2]).toEqual(["noteOn", 0, 60, 1, undefined]);
  });

  it("maps trigger handles to voices so release reaches the right one", () => {
    const t = setup();
    t.engine.handleMessage({
      handle: 101,
      id: "a",
      type: "trigger",
      velocity: 0.8,
    });
    t.engine.handleMessage({
      handle: 102,
      id: "b",
      pan: -1,
      pitch: 3,
      seed: 9,
      type: "trigger",
    });
    t.engine.handleMessage({ handle: 102, type: "release" });
    t.engine.handleMessage({ handle: 101, type: "release" });
    t.engine.handleMessage({ handle: 101, type: "release" });
    t.engine.handleMessage({ handle: 999, type: "release" });
    const { calls } = t.synth();
    expect(calls[1]).toEqual(["trigger", "b", { pan: -1, pitch: 3, seed: 9 }]);
    // synth voices were 1 and 2; releases hit 2 then 1, repeats and unknown handles are ignored
    expect(calls.filter((c) => c[0] === "release")).toEqual([
      ["release", 2],
      ["release", 1],
    ]);
  });

  it("forgets the handle of a trigger that got no voice", () => {
    const t = setup({ voices: 1 });
    t.engine.handleMessage({ handle: 1, id: "a", type: "trigger" });
    t.engine.handleMessage({ handle: 2, id: "a", type: "trigger" });
    t.engine.handleMessage({ handle: 2, type: "release" });
    expect(t.synth().calls.filter((c) => c[0] === "release")).toEqual([]);
  });

  it("keeps only the newest handles", () => {
    const t = setup({ voices: 10_000 });
    for (let handle = 1; handle <= 300; handle += 1) {
      t.engine.handleMessage({ handle, id: "a", type: "trigger" });
    }
    t.engine.handleMessage({ handle: 1, type: "release" });
    t.engine.handleMessage({ handle: 300, type: "release" });
    expect(t.synth().calls.filter((c) => c[0] === "release")).toEqual([
      ["release", 300],
    ]);
  });
});

describe("processor: rendering", () => {
  it("renders the synth's block into both channels and keeps the node alive", () => {
    const t = setup();
    expect(t.block()).toBe(true);
    expect(Math.max(...t.left)).toBe(0);
    t.engine.handleMessage({ type: "play" });
    expect(t.block()).toBe(true);
    expect(Math.max(...t.left)).toBeGreaterThan(0.05);
    expect(Array.from(t.right)).toEqual(Array.from(t.left));
    expect(t.synth().frame).toBe(256);
  });

  it("handles a mono output and an empty output list", () => {
    const t = setup();
    expect(t.engine.process([])).toBe(true);
    expect(t.engine.process([[]])).toBe(true);
    t.engine.handleMessage({ type: "play" });
    expect(t.engine.process([[t.left]])).toBe(true);
    expect(Math.max(...t.left)).toBeGreaterThan(0.05);
  });

  it("splits a longer quantum into blocks of at most 128 and fills all of it", () => {
    const t = setup();
    t.engine.handleMessage({ type: "play" });
    const big = [new Float32Array(300), new Float32Array(300)] as [
      Float32Array,
      Float32Array,
    ];
    t.engine.process([big]);
    expect(t.synth().processed).toEqual([128, 128, 44]);
    expect(t.synth().frame).toBe(300);
    // the last block landed at the end of the buffer, in both channels
    expect(Math.max(...big[0].subarray(256))).toBeGreaterThan(0.05);
    expect(Math.max(...big[1].subarray(256))).toBeGreaterThan(0.05);
  });

  it("posts clock at the first block and then every 1024 frames", () => {
    const t = setup();
    t.engine.handleMessage({ type: "play" });
    for (let i = 0; i < 17; i += 1) {
      t.block();
    }
    const clocks = t.port.of("clock");
    expect(clocks.map((c) => c.frame)).toEqual([
      0,
      CLOCK_FRAMES,
      CLOCK_FRAMES * 2,
    ]);
    const [, second] = clocks;
    expect(second?.time).toBeCloseTo(10 + (8 * 128) / RATE, 9);
    expect(second?.playing).toBe(true);
    expect(second?.position).toEqual({ order: 0, pulse: 0, row: 0, tick: 0 });
  });
});

describe("processor: events", () => {
  it("copies events before posting, since the synth reuses its objects", () => {
    // enough voices that every trigger below makes an event (the synth stops handing out voices at its limit)
    const t = setup({ voices: 100 });
    t.engine.handleMessage({ type: "play" });
    for (let i = 0; i < 4; i += 1) {
      t.block();
    }
    const batches = t.port.of("events");
    expect(batches).toHaveLength(1);
    const first = batches[0]?.events[0] as EngineEvent;
    expect(first).toMatchObject({
      channelId: "pulse1",
      frame: 0,
      hz: 440,
      id: "lead",
      note: 69,
      type: "noteOn",
    });
    // push enough events through the synth's pool of 16 to overwrite the object the first one came from
    for (let i = 1; i <= 20; i += 1) {
      t.engine.handleMessage({ handle: i, id: `s${i}`, type: "trigger" });
      t.block();
    }
    expect(t.synth().calls.filter((c) => c[0] === "trigger")).toHaveLength(20);
    expect(first).toMatchObject({ frame: 0, id: "lead", type: "noteOn" });
  });

  it("batches events instead of posting every block, and stamps the batch with the clock pair of the block that posted it", () => {
    const t = setup();
    t.engine.handleMessage({ type: "play" });
    let blocks = 0;
    while (t.port.of("events").length === 0 && blocks < 10) {
      t.block();
      blocks += 1;
    }
    const [batch] = t.port.of("events");
    expect(batch?.events).toHaveLength(1);
    // held back for a few blocks, but not for long
    expect(blocks).toBeGreaterThan(1);
    expect(blocks).toBeLessThanOrEqual(4);
    // the pair names the start of the block that posted: its frame and the context time at that frame
    const startFrame = (blocks - 1) * 128;
    expect(batch?.clockFrame).toBe(startFrame);
    expect(batch?.clockTime).toBeCloseTo(10 + startFrame / RATE, 9);
  });

  it("flushes at once when a lot of events are waiting", () => {
    const t = setup({ voices: 1000 });
    for (let i = 1; i <= 70; i += 1) {
      t.engine.handleMessage({ handle: i, id: "a", type: "trigger" });
    }
    t.block();
    const batches = t.port.of("events");
    // the fake emits all queued events in one block
    expect(batches[0]?.events.length).toBe(70);
  });

  it("posts ended after the events of the final block", () => {
    const t = setup({ songFrames: 256 });
    t.engine.handleMessage({ type: "play" });
    t.block();
    t.block();
    const order = t.port.posted
      .map((p) => p.message.type)
      .filter((x) => x === "events" || x === "ended");
    expect(order).toEqual(["events", "ended"]);
    const types = t.port.of("events")[0]?.events.map((e) => e.type);
    expect(types).toEqual(["noteOn", "end"]);
    t.block();
    expect(t.port.of("ended")).toHaveLength(1);
  });
});

describe("processor: scopes", () => {
  it("posts copies of the rings with each clock, transferred", () => {
    const t = setup();
    t.engine.handleMessage({ type: "play" });
    for (let i = 0; i < 9; i += 1) {
      t.block();
    }
    const posts = t.port.posted.filter((p) => p.message.type === "scope");
    expect(posts).toHaveLength(2);
    const [, second] = posts;
    const message = second?.message as Extract<
      NonNullable<typeof second>["message"],
      { type: "scope" }
    >;
    expect(message.frame).toBe(9 * 128);
    expect(message.buffers).toHaveLength(10);
    expect(message.master).toHaveLength(2);
    expect(message.buffers[0]).toHaveLength(1024);
    expect(second?.transfer).toHaveLength(12);
    expect(Math.max(...(message.buffers[0] as Float32Array))).toBeGreaterThan(
      0.05
    );
    // the copy ends at the newest frame: its last sample is the synth's last sample
    expect(message.master[0]?.[1023]).toBe(
      t.synth().scopes.master[0][(9 * 128 - 1) % 2048]
    );
  });

  it("stops posting while a shared buffer is set and resumes when it is cleared", () => {
    const t = setup();
    const shared = new SharedArrayBuffer(64);
    t.engine.handleMessage({ buffer: shared, type: "setScopeBuffer" });
    for (let i = 0; i < 17; i += 1) {
      t.block();
    }
    expect(t.port.of("scope")).toHaveLength(0);
    expect(t.synth().calls[0]).toEqual(["setScopeBuffer", shared]);
    t.engine.handleMessage({ buffer: null, type: "setScopeBuffer" });
    for (let i = 0; i < 17; i += 1) {
      t.block();
    }
    expect(t.port.of("scope").length).toBeGreaterThan(0);
  });

  it("does not post scopes when the node was created without them", () => {
    const t = setup({}, { scopes: false });
    for (let i = 0; i < 17; i += 1) {
      t.block();
    }
    expect(t.port.of("scope")).toHaveLength(0);
  });
});

describe("processor: cpu load", () => {
  it("reports the share of block time spent in process", () => {
    // each read of the clock moves it by 0.25 ms: process spends one such step between its two reads
    let ms = 0;
    const now = () => {
      ms += 0.25;
      return ms;
    };
    const t = setup({}, {}, now);
    for (let i = 0; i < 400; i += 1) {
      t.block();
    }
    const last = t.port.of("clock").at(-1) as ClockMessage;
    const expected = 0.25 / ((128 / RATE) * 1000);
    expect(last.load).toBeGreaterThan(expected * 0.9);
    expect(last.load).toBeLessThan(expected * 1.1);
  });

  it("reports 0 when there is no clock to measure with", () => {
    const t = setup();
    t.block();
    expect((t.port.of("clock")[0] as ClockMessage).load).toBe(0);
  });
});

describe("processor: errors never cross the boundary", () => {
  it("reports a synth that cannot be created and renders silence", () => {
    const t = setup({ throwOn: "create" });
    t.left.fill(1);
    expect(t.block()).toBe(true);
    expect(t.left.every((v) => v === 0)).toBe(true);
    expect(t.port.of("error")[0]?.message).toBe("create failed");
    expect(t.port.of("ready")).toHaveLength(1);
    t.engine.handleMessage({ type: "play" });
    expect(t.port.of("error").at(-1)?.message).toBe(
      "the engine is not running"
    );
  });

  it("reports a trigger the synth throws on, and keeps no handle for it", () => {
    const t = setup({ throwOn: "trigger" });
    t.engine.handleMessage({ handle: 1, id: "a", type: "trigger" });
    expect(t.port.of("error")).toEqual([
      { message: "trigger failed", type: "error" },
    ]);
    t.engine.handleMessage({ handle: 1, type: "release" });
    expect(t.synth().calls.filter((c) => c[0] === "release")).toEqual([]);
  });

  it("turns a throwing message handler into an error message", () => {
    const t = setup({ throwOn: "loadSong" });
    expect(() =>
      t.engine.handleMessage({ instruments: {}, song, type: "loadSong" })
    ).not.toThrow();
    expect(t.port.of("error")).toEqual([
      { message: "loadSong failed", type: "error" },
    ]);
  });

  it("rejects junk messages", () => {
    const t = setup();
    for (const junk of [null, 5, "play", undefined, { type: "nope" }]) {
      expect(() => t.engine.handleMessage(junk)).not.toThrow();
    }
    expect(t.port.of("error").map((e) => e.message)).toEqual([
      "message is not an object",
      'unknown message type "nope"',
    ]);
  });

  it("renders silence when process throws and does not flood the port", () => {
    const t = setup({ throwOn: "process" });
    t.left.fill(1);
    for (let i = 0; i < 100; i += 1) {
      expect(t.block()).toBe(true);
    }
    expect(t.left.every((v) => v === 0)).toBe(true);
    // 100 blocks is 12800 frames, well under the one-second cooldown
    expect(t.port.of("error")).toHaveLength(1);
    // after the cooldown the same failure is reported again
    for (let i = 0; i < 400; i += 1) {
      t.block();
    }
    expect(t.port.of("error").length).toBe(2);
  });

  it("survives a port that throws", () => {
    const t = setup();
    t.port.postMessage = () => {
      throw new Error("closed");
    };
    expect(() => {
      t.block();
      t.block();
    }).not.toThrow();
  });
});

describe("BleepkitProcessor (the registered shell)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("registers bleepkit-engine and wires port, options and process", async () => {
    class TestPort extends FakePort {
      onmessage: ((e: { data: unknown }) => void) | null = null;
    }
    const port = new TestPort();
    const registered: [string, unknown][] = [];
    class Base {
      readonly port = port;
    }
    vi.stubGlobal("AudioWorkletProcessor", Base);
    vi.stubGlobal("registerProcessor", (name: string, ctor: unknown) =>
      registered.push([name, ctor])
    );
    vi.stubGlobal("sampleRate", 44_100);
    vi.stubGlobal("currentTime", 2.5);
    const mod = await import("../src/worklet/processor.ts");
    expect(registered).toEqual([["bleepkit-engine", mod.BleepkitProcessor]]);

    const factory = fakeSynthFactory();
    mod.BleepkitProcessor.createSynth = factory.create;
    const processor = new mod.BleepkitProcessor({
      processorOptions: { scopeFrames: 512, scopes: false, sfxVoices: 3 },
    });
    expect(factory.made[0]?.created).toEqual({
      sampleRate: 44_100,
      scopeFrames: 512,
      sfxVoices: 3,
    });
    expect(port.of("ready")[0]?.sampleRate).toBe(44_100);

    port.onmessage?.({ data: { type: "play" } });
    const first = new Float32Array(128);
    const out = [[first, new Float32Array(128)]];
    expect(processor.process([], out, {})).toBe(true);
    expect(Math.max(...first)).toBeGreaterThan(0.05);
    const [clock] = port.of("clock");
    expect(clock?.time).toBe(2.5);
    // scopes: false in processorOptions means no posted copies
    for (let i = 0; i < 20; i += 1) {
      processor.process([], out, {});
    }
    expect(port.of("scope")).toHaveLength(0);
  });

  it("ignores processor options that are not usable numbers or flags", async () => {
    class Base {
      readonly port = new FakePort();
    }
    vi.stubGlobal("AudioWorkletProcessor", Base);
    vi.stubGlobal("registerProcessor", () => undefined);
    vi.stubGlobal("sampleRate", 48_000);
    const mod = await import("../src/worklet/processor.ts");
    const factory = fakeSynthFactory();
    mod.BleepkitProcessor.createSynth = factory.create;
    // the main thread controls these, but a hand-made node must not be able to break the engine
    const junk = {
      processorOptions: {
        scopeFrames: Number.NaN,
        scopes: "no",
        sfxVoices: "4",
      },
    };
    expect(() => new mod.BleepkitProcessor(junk)).not.toThrow();
    expect(factory.made[0]?.created).toEqual({ sampleRate: 48_000 });
    expect(
      () => new mod.BleepkitProcessor({ processorOptions: null })
    ).not.toThrow();
  });

  it("loads without a worklet scope and still renders (nothing to register, nothing thrown)", async () => {
    vi.stubGlobal("AudioWorkletProcessor", undefined);
    vi.stubGlobal("registerProcessor", undefined);
    const mod = await import("../src/worklet/processor.ts");
    mod.BleepkitProcessor.createSynth = fakeSynthFactory().create;
    const p = new mod.BleepkitProcessor();
    const left = new Float32Array(128);
    p.port.onmessage?.({ data: { type: "play" } });
    expect(p.process([], [[left]], {})).toBe(true);
    expect(Math.max(...left)).toBeGreaterThan(0.05);
  });
});
