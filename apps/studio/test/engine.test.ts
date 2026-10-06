/* The studio's engine wrapper (src/engine/engine.ts) against a recording stand-in for the player's engine node.

   The first group is the regression test for the studio that shipped silent: createEngineNode leaves routing to its
   caller, and a studio that forgets to connect the node still animates every scope (they read the engine's own rings)
   while playing nothing. The rest guards the other ways a studio can look alive and do nothing the user can hear:
   a sound edit that is never uploaded to the engine, a song that is never reloaded, a context that is never resumed. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FromWorklet, ToWorklet } from "../src/lib/contract.ts";
import { defaultInstrument, defaultSfx } from "../src/lib/core.ts";
import { starterFiles } from "../src/store/seed.ts";

const player = vi.hoisted(() => ({
  connect: vi.fn(),
  createCalls: [] as { ctx: unknown; workletUrl: unknown }[],
  fail: false,
  frame: 0,
  handlers: [] as ((msg: unknown) => void)[],
  sent: [] as Record<string, unknown>[],
}));

vi.mock("@bleepkit/player", () => ({
  createEngineNode: vi.fn((ctx: unknown, opts: { workletUrl?: unknown }) => {
    player.createCalls.push({ ctx, workletUrl: opts.workletUrl });
    if (player.fail) {
      return Promise.reject(new Error("worklet blocked"));
    }
    return Promise.resolve({
      dispose: vi.fn(),
      node: { connect: player.connect },
      nowFrame: () => player.frame,
      on: (handler: (msg: unknown) => void) => {
        player.handlers.push(handler);
        return () => undefined;
      },
      scopes: {
        at: () => new Float32Array(0),
        latest: () => new Float32Array(0),
      },
      send: (msg: Record<string, unknown>) => player.sent.push(msg),
    });
  }),
}));

/** A context that behaves like a browser's: suspended until resumed, and it tells listeners when that changes. */
class FakeContext {
  static all: FakeContext[] = [];
  readonly destination = { kind: "destination" };
  readonly gains: {
    connect: ReturnType<typeof vi.fn>;
    gain: { value: number };
  }[] = [];
  readonly sampleRate = 48_000;
  refuseResume = false;
  state = "suspended";
  private readonly listeners: (() => void)[] = [];
  constructor() {
    FakeContext.all.push(this);
  }
  addEventListener(_type: string, fn: () => void): void {
    this.listeners.push(fn);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  createGain() {
    const g = { connect: vi.fn(), gain: { value: 1 } };
    this.gains.push(g);
    return g;
  }
  resume(): Promise<void> {
    if (this.refuseResume) {
      return Promise.reject(new Error("needs a gesture"));
    }
    this.state = "running";
    for (const fn of this.listeners) {
      fn();
    }
    return Promise.resolve();
  }
}

type Engine = typeof import("../src/engine/engine.ts")["engine"];

/** A fresh engine (the module is a singleton) initialised against the fake context. */
async function started(opts: { fake?: boolean } = { fake: false }) {
  vi.resetModules();
  const { engine } = await import("../src/engine/engine.ts");
  await engine.init(opts);
  return engine;
}

const kinds = () => player.sent.map((m) => m.type);
const deliver = (msg: FromWorklet) => {
  for (const h of player.handlers) {
    h(msg);
  }
};

let current: Engine | null = null;

beforeEach(() => {
  vi.stubGlobal("AudioContext", FakeContext);
  FakeContext.all = [];
  player.connect.mockClear();
  player.createCalls = [];
  player.fail = false;
  player.frame = 0;
  player.handlers = [];
  player.sent = [];
});

afterEach(() => {
  current?.dispose();
  current = null;
  vi.unstubAllGlobals();
});

const boot = async (opts?: { fake?: boolean }) => {
  current = await started(opts);
  return current;
};

describe("engine routing", () => {
  it("connects the real engine node to the context destination, once", async () => {
    const engine = await boot();
    // the worklet bundle is built by Turbo before the studio's tests; without it the studio falls back to the fake
    expect(engine.fake).toBe(false);
    const ctx = FakeContext.all[0] as FakeContext;
    expect(player.createCalls[0]?.ctx).toBe(ctx);
    expect(typeof player.createCalls[0]?.workletUrl).toBe("string");
    expect(player.connect).toHaveBeenCalledTimes(1);
    expect(player.connect).toHaveBeenCalledWith(ctx.destination);
  });

  it("still reaches the speakers through the fake engine when the worklet cannot start", async () => {
    player.fail = true;
    const engine = await boot();
    expect(engine.fake).toBe(true);
    expect(engine.error).toBe("worklet blocked");
    expect(player.connect).not.toHaveBeenCalled();
    const ctx = FakeContext.all[0] as FakeContext;
    // the fake engine's output gain is its only way to be heard
    expect(ctx.gains.length).toBeGreaterThan(0);
    expect(ctx.gains[0]?.connect).toHaveBeenCalledWith(ctx.destination);
  });

  it("asks for the fake engine on request, without touching the worklet", async () => {
    const engine = await boot({ fake: true });
    expect(engine.fake).toBe(true);
    expect(player.createCalls).toEqual([]);
  });
});

describe("the audio context lock", () => {
  it("reports locked until a gesture resumes the context", async () => {
    const engine = await boot();
    expect(engine.status).toBe("locked");
    const changes = vi.fn();
    engine.onChange(changes);
    await engine.unlock();
    expect((FakeContext.all[0] as FakeContext).state).toBe("running");
    expect(engine.status).toBe("running");
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("stays locked, without throwing, when the browser refuses to resume", async () => {
    const engine = await boot();
    (FakeContext.all[0] as FakeContext).refuseResume = true;
    await engine.unlock();
    expect(engine.status).toBe("locked");
  });
});

describe("sounds reach the engine as the user edited them", () => {
  const coin = () => defaultSfx("nes");

  it("uploads a sound once, then only triggers it", async () => {
    const engine = await boot();
    engine.triggerSfx("coin", coin());
    engine.triggerSfx("coin", coin());
    expect(kinds()).toEqual(["loadSfx", "trigger", "trigger"]);
  });

  it("uploads the sound again after it is edited, before it plays", async () => {
    const engine = await boot();
    const before = coin();
    engine.triggerSfx("coin", before);
    player.sent.length = 0;
    const edited = {
      ...before,
      frequency: { ...before.frequency, start: before.frequency.start * 2 },
    };
    engine.triggerSfx("coin", edited);
    expect(kinds()).toEqual(["loadSfx", "trigger"]);
    const upload = player.sent[0] as Extract<ToWorklet, { type: "loadSfx" }>;
    expect(upload.id).toBe("coin");
    expect(upload.sfx.frequency.start).toBe(before.frequency.start * 2);
  });

  it("keeps the sounds apart by id", async () => {
    const engine = await boot();
    engine.triggerSfx("a", coin());
    engine.triggerSfx("b", coin());
    expect(kinds()).toEqual(["loadSfx", "trigger", "loadSfx", "trigger"]);
  });

  it("hands out a new voice handle per trigger and passes the options on", async () => {
    const engine = await boot();
    const first = engine.triggerSfx("coin", coin(), {
      pan: -0.5,
      velocity: 0.4,
    });
    const second = engine.triggerSfx("coin", coin());
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
    expect(second).not.toBe(first);
    expect(player.sent[1]).toMatchObject({
      handle: first,
      id: "coin",
      pan: -0.5,
      type: "trigger",
      velocity: 0.4,
    });
    engine.releaseSfx(first);
    expect(player.sent.at(-1)).toEqual({ handle: first, type: "release" });
  });

  it("announces a trigger to the visuals at once, and drops the engine's own copy of it", async () => {
    const engine = await boot();
    const sfx = coin();
    engine.triggerSfx("coin", sfx, { velocity: 0.5 });
    deliver({
      clockFrame: 0,
      clockTime: 0,
      events: [
        {
          channel: -1,
          channelId: "",
          frame: 0,
          hz: 0,
          id: "coin",
          note: 0,
          order: -1,
          row: -1,
          type: "trigger",
          velocity: 1,
        },
      ],
      type: "events",
    });
    const seen = engine.drain();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      channelId: sfx.category,
      hz: sfx.frequency.start,
      id: "coin",
      type: "trigger",
      velocity: 0.5,
    });
  });

  it("hands out the engine's events only once they are audible", async () => {
    const engine = await boot();
    const noteOn = (frame: number) =>
      ({
        channel: 0,
        channelId: "pulse1",
        frame,
        hz: 440,
        id: "lead",
        note: 69,
        order: 0,
        row: 0,
        type: "noteOn",
        velocity: 1,
      }) as const;
    deliver({
      clockFrame: 0,
      clockTime: 0,
      events: [noteOn(1000), noteOn(2000)],
      type: "events",
    });
    player.frame = 999.9;
    expect(engine.drain()).toEqual([]);
    player.frame = 1000.7;
    expect(engine.nowFrame()).toBe(1000);
    expect(engine.drain().map((e) => e.frame)).toEqual([1000]);
    player.frame = 5000;
    expect(engine.drain().map((e) => e.frame)).toEqual([2000]);
    expect(engine.drain()).toEqual([]);
  });
});

describe("songs and instruments reach the engine as the user edited them", () => {
  const files = starterFiles();
  const song = () =>
    structuredClone(files.get("songs/starter-theme.json")) as never as {
      tempo: number;
    };
  const instruments = () =>
    Object.fromEntries(
      [...files]
        .filter(([p]) => p.startsWith("instruments/"))
        .map(([p, v]) => [p.replace(/^.*\/|\.json$/g, ""), structuredClone(v)])
    ) as never as Record<string, { name: string }>;
  const load = (engine: Engine, s = song(), i = instruments()) =>
    engine.loadSong(s as never, i as never, []);

  it("loads a song once, and again after the song or one of its instruments changes", async () => {
    const engine = await boot();
    load(engine);
    load(engine);
    expect(kinds()).toEqual(["loadSong"]);
    const edited = song();
    edited.tempo += 10;
    load(engine, edited);
    expect(kinds()).toEqual(["loadSong", "loadSong"]);
    const tweaked = instruments();
    const [first] = Object.values(tweaked);
    (first as { name: string }).name = "renamed";
    load(engine, edited, tweaked);
    expect(kinds()).toEqual(["loadSong", "loadSong", "loadSong"]);
  });

  it("sends play, pause and stop, and tracks whether a song is playing", async () => {
    const engine = await boot();
    engine.playSong({ order: 1, row: 8 });
    expect(player.sent.at(-1)).toEqual({ order: 1, row: 8, type: "play" });
    expect(engine.playing).toBe(true);
    engine.pauseSong();
    expect(player.sent.at(-1)).toEqual({ type: "pause" });
    expect(engine.playing).toBe(false);
    engine.playSong();
    deliver({
      frame: 0,
      playing: true,
      position: { order: 2, pulse: 192, row: 4, tick: 0 },
      time: 0,
      type: "clock",
    });
    expect(engine.position).toMatchObject({ order: 2, row: 4 });
    engine.stopAll();
    expect(player.sent.at(-1)).toEqual({ type: "stop" });
    expect(engine.playing).toBe(false);
    expect(engine.position).toBeNull();
  });

  it("follows the engine when a song ends by itself", async () => {
    const engine = await boot();
    engine.playSong();
    deliver({ type: "ended" });
    expect(engine.playing).toBe(false);
  });

  it("converts the engine's song position to seconds at 96 pulses per beat", async () => {
    const engine = await boot();
    const s = song();
    s.tempo = 120;
    load(engine, s);
    deliver({
      frame: 0,
      playing: true,
      position: { order: 0, pulse: 192, row: 0, tick: 0 },
      time: 0,
      type: "clock",
    });
    // two beats at 120 bpm
    expect(engine.songSeconds()).toBeCloseTo(1, 6);
    engine.setTempo(60);
    expect(player.sent.at(-1)).toEqual({ tempo: 60, type: "setTempo" });
    expect(engine.songSeconds()).toBeCloseTo(2, 6);
  });

  it("uploads an instrument once and again after an edit", async () => {
    const engine = await boot();
    const inst = defaultInstrument("pulse", "nes");
    engine.setInstrument("lead", inst);
    engine.setInstrument("lead", structuredClone(inst));
    expect(kinds()).toEqual(["setInstrument"]);
    engine.setInstrument("lead", { ...inst, name: "changed" });
    expect(kinds()).toEqual(["setInstrument", "setInstrument"]);
  });

  it("holds a preview note on a channel of the instrument's kind, dropping a loaded song first", async () => {
    const engine = await boot();
    load(engine);
    player.sent.length = 0;
    const pulse = defaultInstrument("pulse", "nes");
    const fm = defaultInstrument("fm", "genesis");
    const a = engine.previewNoteOn("lead", pulse, 60, 0.8);
    const b = engine.previewNoteOn("bell", fm, 64);
    expect(a).not.toBe(b);
    expect(kinds()).toEqual([
      "unloadSong",
      "setInstrument",
      "noteOn",
      "setInstrument",
      "noteOn",
    ]);
    expect(player.sent[2]).toEqual({
      channel: a,
      instrument: "lead",
      note: 60,
      type: "noteOn",
      velocity: 0.8,
    });
    expect(player.sent[4]).toMatchObject({ channel: b, instrument: "bell" });
  });
});
