import type { Instrument, Sfx, Song } from "@bleepkit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlayer } from "../src/player.ts";
import type { AudioManifest, BleepPlayer } from "../src/types.ts";
import {
  audioBytes,
  FakeContext,
  type FakeGain,
  FakeWorkletNode,
  fakeFetch,
  installWebAudioGlobals,
  linkWorklets,
} from "./fake-audio.ts";

const song = {
  loop: 1,
  name: "title",
  order: ["a", "b"],
  patterns: { a: { length: 16, tracks: {} }, b: { length: 32, tracks: {} } },
  rowsPerBeat: 4,
  tempo: 120,
} as unknown as Song;
const data = (name: string, loop: number | null = 1) => ({
  instruments: {} as Record<string, Instrument>,
  song: { ...song, loop, name },
});

const manifest = {
  base: "/audio/",
  sampleRate: 48_000,
  sfx: {
    coin: {
      data: { name: "coin" } as unknown as Sfx,
      duration: 0.3,
      file: "coin.ogg",
    },
    laser: { duration: 0.4, file: "laser.ogg" },
  },
  songs: {
    boss: {
      data: data("boss", null),
      duration: 12,
      file: "boss.ogg",
      loopEnd: null,
      loopStart: null,
    },
    title: {
      data: data("title"),
      duration: 25,
      file: "title.ogg",
      loopEnd: 24,
      loopStart: 4.8,
    },
  },
} satisfies AudioManifest;

let ctx: FakeContext;
let errors: Error[];
let rig: ReturnType<typeof linkWorklets>;

async function make(opts: Partial<Parameters<typeof createPlayer>[0]> = {}) {
  return await createPlayer({
    context: ctx.asContext(),
    manifest,
    onError: (e) => errors.push(e),
    unlockOnGesture: false,
    workletUrl: "/w.js",
    ...opts,
  });
}

const calls = (index: number) => rig.linked[index]?.synth().calls ?? [];
const names = (index: number) => calls(index).map((c) => c[0]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("AudioWorkletNode", installWebAudioGlobals());
  vi.stubGlobal(
    "Audio",
    class {
      canPlayType() {
        return "maybe";
      }
    }
  );
  ctx = new FakeContext();
  errors = [];
  rig = linkWorklets({ songFrames: 128 * 20 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWorkletNode.hook = null;
});

describe("synth mode setup", () => {
  it("makes one engine per kind of document and wires them to their buses", async () => {
    await make({ maxSfxVoices: 6 });
    expect(ctx.modules).toEqual(["/w.js", "/w.js"]);
    const [sfxNode, musicNode] = FakeWorkletNode.instances;
    expect(sfxNode?.options.processorOptions).toMatchObject({
      scopes: false,
      sfxVoices: 6,
    });
    expect(musicNode?.options.processorOptions).toMatchObject({
      scopes: false,
    });
    const [master, sfxBus, musicBus, fade] = ctx.gains as FakeGain[];
    expect(master).toBeDefined();
    expect(sfxNode?.outputs).toEqual([sfxBus]);
    expect(musicNode?.outputs).toEqual([fade]);
    expect(fade?.outputs).toEqual([musicBus]);
  });

  it("makes only the engines the manifest has documents for", async () => {
    await make({ manifest: { ...manifest, songs: {} } });
    expect(FakeWorkletNode.instances).toHaveLength(1);
    expect(FakeWorkletNode.instances[0]?.outputs[0]).toBe(ctx.gains[1]);
  });

  it("stays on files when the manifest embeds nothing (auto) or the mode says files", async () => {
    await make({
      manifest: { ...manifest, sfx: { laser: manifest.sfx.laser }, songs: {} },
    });
    await make({ mode: "files" });
    expect(FakeWorkletNode.instances).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  it("says so when synth is demanded but nothing is embedded, and uses files", async () => {
    await make({
      manifest: { ...manifest, sfx: { laser: manifest.sfx.laser }, songs: {} },
      mode: "synth",
    });
    expect(errors[0]?.message).toContain("embeds no documents");
    expect(FakeWorkletNode.instances).toHaveLength(0);
  });

  it("falls back to files when the worklet cannot be loaded", async () => {
    ctx.moduleError = "blocked";
    vi.stubGlobal(
      "fetch",
      fakeFetch({ "/audio/coin.ogg": audioBytes(0.3) }).fn
    );
    const p = await make();
    expect(errors[0]?.message).toContain(
      "could not load the Bleepkit worklet from /w.js: blocked"
    );
    p.sfx("coin");
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.sources).toHaveLength(1);
  });
});

describe("synth mode sound effects", () => {
  it("loads the document once, then triggers with the game's options", async () => {
    const p = await make();
    const h = p.sfx("coin", { pan: -1, pitch: 2, velocity: 0.5 });
    p.sfx("coin");
    expect(names(0)).toEqual(["loadSfx", "trigger", "trigger"]);
    expect(calls(0)[0]).toEqual(["loadSfx", "coin", { name: "coin" }]);
    expect(calls(0)[1]).toEqual([
      "trigger",
      "coin",
      { pan: -1, pitch: 2, velocity: 0.5 },
    ]);
    expect(calls(0)[2]).toEqual(["trigger", "coin", {}]);
    expect(h.id).toBe("coin");
  });

  it("releases the voice it started", async () => {
    const p = await make();
    p.sfx("coin");
    const h = p.sfx("coin");
    h.stop();
    expect(calls(0).at(-1)).toEqual(["release", 2]);
  });

  it("plays a sound without a document from its file", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch({ "/audio/laser.ogg": audioBytes(0.4) }).fn
    );
    const p = await make();
    p.sfx("laser");
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.sources).toHaveLength(1);
    expect(names(0)).not.toContain("trigger");
  });

  it("preloads documents into the engine", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch({ "/audio/laser.ogg": audioBytes(0.4) }).fn
    );
    const p = await make();
    await p.preload();
    expect(names(0)).toEqual(["loadSfx"]);
  });

  it("delivers worklet events to listeners when they become audible", async () => {
    const p = await make();
    const seen: { time: number; id: string; type: string }[] = [];
    p.on("trigger", (e) => seen.push(e));
    p.sfx("coin", { velocity: 0.9 });
    rig.runBlocks(ctx, 4);
    expect(seen).toEqual([]);
    // the batch is stamped at block 3 (frame 384); the event is at frame 0 and audible 50 ms after rendering
    ctx.currentTime = 0.049;
    vi.advanceTimersByTime(10);
    expect(seen).toEqual([]);
    ctx.currentTime = 0.06;
    vi.advanceTimersByTime(10);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.time).toBeCloseTo(0.05, 9);
    expect(seen[0]).toMatchObject({ id: "coin", type: "trigger" });
  });

  it("reports an error from the worklet and keeps going", async () => {
    const p = await make();
    p.sfx("coin");
    FakeWorkletNode.instances[0]?.port.emit({ message: "boom", type: "error" });
    expect(errors.map((e) => e.message)).toEqual(["worklet: boom"]);
  });
});

describe("synth mode music", () => {
  it("loads the song and plays it from a row, with the song's own loop", async () => {
    const p = await make();
    ctx.currentTime = 1;
    const h = await p.music("title", { fadeIn: 1, startAt: 2 });
    expect(names(1)).toEqual(["loadSong", "play"]);
    expect(calls(1)[1]).toEqual(["play", { loop: true, order: 1, row: 0 }]);
    const fade = ctx.gains[3] as FakeGain;
    expect(fade.gain.log.slice(-2)).toEqual([
      ["set", 0, 1],
      ["ramp", 1, 2],
    ]);
    // the engine reports the position in its clock
    rig.runBlocks(ctx, 2);
    expect(h.position()).toMatchObject({ order: 1, row: 0 });
  });

  it("does not loop a song without a loop section, unless asked", async () => {
    const p = await make();
    await p.music("boss");
    expect(calls(1)[1]).toEqual(["play", { loop: false }]);
    const second = p.music("boss", { loop: true });
    await vi.advanceTimersByTimeAsync(100);
    await second;
    expect(
      calls(1)
        .filter((c) => c[0] === "play")
        .at(-1)
    ).toEqual(["play", { loop: true }]);
  });

  it("fades the old song out before the next one replaces it", async () => {
    const p = await make();
    ctx.currentTime = 5;
    await p.music("title");
    const next = p.music("boss", { fadeIn: 0 });
    const fade = ctx.gains[3] as FakeGain;
    expect(fade.gain.log.slice(-3)).toEqual([
      ["cancel", 5],
      ["set", 1, 5],
      ["ramp", 0, 5.04],
    ]);
    expect(names(1)).toEqual(["loadSong", "play"]);
    await vi.advanceTimersByTimeAsync(100);
    await next;
    expect(names(1)).toEqual(["loadSong", "play", "stop", "loadSong", "play"]);
  });

  it("stops after the fade out, unless a new song took over meanwhile", async () => {
    const p = await make();
    await p.music("title");
    p.stopMusic({ fadeOut: 0.5 });
    expect(names(1)).toEqual(["loadSong", "play"]);
    await vi.advanceTimersByTimeAsync(600);
    expect(names(1)).toEqual(["loadSong", "play", "stop"]);

    await p.music("boss");
    p.stopMusic({ fadeOut: 0.5 });
    await vi.advanceTimersByTimeAsync(100);
    await p.music("title");
    await vi.advanceTimersByTimeAsync(600);
    // the stop scheduled for the first boss run never hits the newer title
    expect(names(1).filter((n) => n === "stop")).toHaveLength(1);
  });

  it("stops through the handle only while it is current", async () => {
    const p = await make();
    const h = await p.music("title");
    h.stop();
    h.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(names(1).filter((n) => n === "stop")).toHaveLength(1);
    expect(h.position()).toBeNull();
  });

  it("knows when the song ended by itself, so the next one starts at once", async () => {
    const p = await make();
    await p.music("boss");
    rig.runBlocks(ctx, 25);
    // a pending switch would wait on a timer; with fake timers that would hang this await
    await expect(p.music("title")).resolves.toMatchObject({ id: "title" });
    expect(names(1).filter((n) => n === "loadSong")).toHaveLength(2);
  });

  it("stops files music when a song with a document starts, and the other way round", async () => {
    vi.stubGlobal("fetch", fakeFetch({ "/audio/odd.ogg": audioBytes(5) }).fn);
    const mixed = {
      ...manifest,
      songs: {
        ...manifest.songs,
        odd: { duration: 5, file: "odd.ogg", loopEnd: null, loopStart: null },
      },
    };
    const p = (await make({ manifest: mixed })) as BleepPlayer;
    await p.music("odd");
    const fileSource = ctx.sources.at(-1);
    await p.music("title");
    expect(fileSource?.stops).toHaveLength(1);
    await p.music("odd");
    await vi.advanceTimersByTimeAsync(100);
    expect(names(1)).toContain("stop");
  });

  it("reports a song id with no document", async () => {
    const p = (await make({
      manifest: {
        ...manifest,
        songs: {
          x: { duration: 1, file: "x.ogg", loopEnd: null, loopStart: null },
          ...manifest.songs,
        },
      },
    })) as BleepPlayer;
    vi.stubGlobal("fetch", fakeFetch({}).fn);
    await p.music("x");
    expect(errors[0]?.message).toContain("could not load /audio/x.ogg");
  });
});

describe("synth mode teardown", () => {
  it("disposes the engines", async () => {
    const p = await make();
    p.dispose();
    for (const node of FakeWorkletNode.instances) {
      expect(node.port.closed).toBe(true);
      expect(node.disconnected).toBe(true);
    }
  });
});
