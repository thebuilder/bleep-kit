// @vitest-environment node
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
  active: [] as boolean[],
  connect: vi.fn(),
  createCalls: [] as { ctx: unknown; workletUrl: unknown }[],
  disposed: 0,
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
      dispose: () => {
        player.disposed += 1;
      },
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
      setActive: (on: boolean) => player.active.push(on),
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
  closed = false;
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
    this.closed = true;
    return Promise.resolve();
  }
  createGain() {
    const g = { connect: vi.fn(), gain: { value: 1 } };
    this.gains.push(g);
    return g;
  }
  /** The browser reporting that `state` changed. */
  notify(): void {
    for (const fn of this.listeners) {
      fn();
    }
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
  player.active = [];
  player.connect.mockClear();
  player.createCalls = [];
  player.disposed = 0;
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
    // a clock that says "playing" before the studio asked for play is the old song's, so it is not believed
    engine.playSong();
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

  it("uploads an instrument again once a song load or unload made the worklet drop it", async () => {
    const engine = await boot();
    const inst = defaultInstrument("pulse", "nes");
    engine.setInstrument("mine", inst);
    // loadSong keeps only the instruments it came with: "mine" is gone from the worklet, so it must be sent again
    load(engine);
    player.sent.length = 0;
    engine.setInstrument("mine", inst);
    expect(kinds()).toEqual(["setInstrument"]);
    // the instruments a song came with are known to be there
    const [firstId] = Object.keys(instruments());
    const known = instruments()[firstId as string] as never;
    engine.setInstrument(firstId as string, known);
    expect(kinds()).toEqual(["setInstrument"]);
    // unloading drops them all again
    engine.unloadSong();
    engine.setInstrument("mine", inst);
    expect(kinds()).toEqual(["setInstrument", "unloadSong", "setInstrument"]);
  });

  it("does not believe a clock that was already on its way when a song was loaded, until the song plays", async () => {
    const engine = await boot();
    load(engine);
    engine.playSong();
    deliver({
      frame: 0,
      playing: true,
      position: { order: 3, pulse: 96, row: 8, tick: 0 },
      time: 0,
      type: "clock",
    });
    expect(engine.position?.order).toBe(3);
    const other = song();
    other.tempo += 5;
    load(engine, other);
    expect(engine.playing).toBe(false);
    expect(engine.position).toBeNull();
    deliver({
      frame: 1024,
      playing: true,
      position: { order: 3, pulse: 192, row: 16, tick: 0 },
      time: 0.02,
      type: "clock",
    });
    expect(engine.playing).toBe(false);
    expect(engine.position).toBeNull();
    engine.playSong();
    deliver({
      frame: 2048,
      playing: true,
      position: { order: 0, pulse: 6, row: 0, tick: 0 },
      time: 0.04,
      type: "clock",
    });
    expect(engine.position?.order).toBe(0);
  });

  it("knows which song document it holds", async () => {
    const engine = await boot();
    expect(engine.hasSong("starter-theme")).toBe(false);
    engine.loadSong(
      song() as never,
      instruments() as never,
      [],
      "starter-theme"
    );
    expect(engine.hasSong("starter-theme")).toBe(true);
    expect(engine.hasSong("other")).toBe(false);
    engine.unloadSong();
    expect(engine.hasSong("starter-theme")).toBe(false);
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

describe("a page that is hidden, and an engine that is rebuilt", () => {
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
  const ev = (frame: number, id = "x") =>
    ({
      channel: 0,
      channelId: "",
      frame,
      hz: 0,
      id,
      note: 60,
      order: 0,
      row: 0,
      type: "noteOn",
      velocity: 1,
    }) as never;
  const eventsMsg = (frames: number[]): FromWorklet => ({
    clockFrame: 0,
    clockTime: 0,
    events: frames.map((f) => ev(f)),
    type: "events",
  });

  it("holds at most 2000 events, dropping the oldest, however long nothing takes them out", async () => {
    const engine = await boot();
    for (let i = 0; i < 30; i += 1) {
      deliver(eventsMsg(Array.from({ length: 500 }, (_, k) => i * 500 + k)));
    }
    player.frame = 1e9;
    const got = engine.drain();
    expect(got).toHaveLength(2000);
    expect(got[0]?.frame).toBe(13_000);
    expect(got.at(-1)?.frame).toBe(14_999);
  });

  describe("with a page to watch", () => {
    const doc = Object.assign(new EventTarget(), {
      visibilityState: "visible" as string,
    });
    const win = new EventTarget();
    const setVisibility = (state: "hidden" | "visible") => {
      doc.visibilityState = state;
      doc.dispatchEvent(new Event("visibilitychange"));
    };
    beforeEach(() => {
      doc.visibilityState = "visible";
      vi.stubGlobal("document", doc);
      vi.stubGlobal("window", win);
    });

    it("stops collecting events while hidden, tells the worklet, and starts from nothing on return", async () => {
      const engine = await boot();
      deliver(eventsMsg([10, 20]));
      engine.announce({ type: "trigger" });
      setVisibility("hidden");
      expect(player.active).toEqual([false]);
      // events that arrive while nobody draws are dropped, and so are the ones that were waiting
      deliver(eventsMsg([30, 40]));
      engine.announce({ type: "trigger" });
      player.frame = 1000;
      expect(engine.drain()).toEqual([]);
      setVisibility("visible");
      expect(player.active).toEqual([false, true]);
      deliver(eventsMsg([50]));
      expect(engine.drain().map((e) => e.frame)).toEqual([50]);
    });

    it("rebuilds the context and the node when the context was closed under it", async () => {
      const engine = await boot();
      await engine.unlock();
      const first = FakeContext.all[0] as FakeContext;
      first.state = "closed";
      first.notify();
      await vi.waitFor(() => expect(engine.rebuilds).toBe(1));
      expect(engine.lastRebuild).toBe("closed");
      expect(FakeContext.all).toHaveLength(2);
      expect(player.createCalls).toHaveLength(2);
      expect(player.createCalls[1]?.ctx).toBe(FakeContext.all[1]);
      expect(player.disposed).toBe(1);
      expect(player.connect).toHaveBeenLastCalledWith(
        (FakeContext.all[1] as FakeContext).destination
      );
    });
  });

  it("gives the new engine the song, the master, the channels and the position the old one had", async () => {
    const engine = await boot();
    await engine.unlock();
    const s = song();
    const i = instruments();
    engine.loadSong(s as never, i as never, [], "theme");
    engine.setMaster({ volume: 0.5 });
    engine.setChannel(1, { muted: true });
    engine.setTempo(s.tempo + 20);
    engine.playSong({ loop: true });
    deliver({
      frame: 0,
      playing: true,
      position: { order: 2, pulse: 96, row: 8, tick: 0 },
      time: 0,
      type: "clock",
    });
    player.sent = [];
    await engine.rebuild("sample-rate");
    expect(engine.lastRebuild).toBe("sample-rate");
    expect(player.disposed).toBe(1);
    expect((FakeContext.all[0] as FakeContext).closed).toBe(true);
    // the song first (the worklet resets channels on a load), then the settings, then play from where it was
    expect(kinds()).toEqual([
      "loadSong",
      "setTempo",
      "setMaster",
      "setChannel",
      "play",
    ]);
    expect(player.sent.at(-1)).toEqual({
      loop: true,
      order: 2,
      row: 8,
      type: "play",
    });
    expect(player.sent[2]).toEqual({ type: "setMaster", volume: 0.5 });
    expect(engine.hasSong("theme")).toBe(true);
    expect(engine.playing).toBe(true);
    // sounds and instruments are uploaded again when they are used next
    const sfx = defaultSfx("nes");
    player.sent = [];
    engine.triggerSfx("coin", sfx);
    expect(kinds()).toEqual(["loadSfx", "trigger"]);
  });

  it("does not rebuild the fake engine", async () => {
    const engine = await boot({ fake: true });
    await engine.rebuild("closed");
    expect(engine.rebuilds).toBe(0);
    expect(FakeContext.all).toHaveLength(1);
  });
});
