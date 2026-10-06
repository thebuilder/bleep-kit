import type { Instrument, Sfx, Song } from "@bleepkit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlayer } from "../src/player.ts";
import type { AudioManifest, BleepPlayer } from "../src/types.ts";
import {
  audioBytes,
  FakeContext,
  type FakeSource,
  FakeWorkletNode,
  fakeFetch,
  heardLevel,
  installWebAudioGlobals,
  type Linked,
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

// the sfx engine is the one made with a voice count; the music engine is the other one
const sfxEngine = () =>
  rig.linked.find(
    (l) => l.node.options.processorOptions?.sfxVoices !== undefined
  ) as Linked;
const musicEngine = () =>
  rig.linked.find(
    (l) => l.node.options.processorOptions?.sfxVoices === undefined
  ) as Linked;
const callsOf = (engine: Linked) => engine.synth().calls;
const namesOf = (engine: Linked) => callsOf(engine).map((c) => c[0]);
/** Level at the speakers of what an engine node outputs, at context time `at`. */
const gainOf = (engine: Linked, at = ctx.currentTime) =>
  ctx.audibleGain(engine.node, at);

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
  it("makes one engine per kind of document, each reaching the speakers through its own bus", async () => {
    await make({
      buses: { master: 0.8, music: 0.25, sfx: 0.5 },
      maxSfxVoices: 6,
    });
    expect(FakeWorkletNode.instances).toHaveLength(2);
    expect(new Set(ctx.modules)).toEqual(new Set(["/w.js"]));
    expect(sfxEngine().node.options.processorOptions).toMatchObject({
      scopes: false,
      sfxVoices: 6,
    });
    expect(musicEngine().node.options.processorOptions).toMatchObject({
      scopes: false,
    });
    expect(gainOf(sfxEngine())).toBeCloseTo(0.5 * 0.8, 9);
    expect(gainOf(musicEngine())).toBeCloseTo(0.25 * 0.8, 9);
  });

  it("makes only the engines the manifest has documents for", async () => {
    await make({ manifest: { ...manifest, songs: {} } });
    expect(FakeWorkletNode.instances).toHaveLength(1);
    expect(rig.linked).toEqual([sfxEngine()]);
    expect(gainOf(sfxEngine())).toBe(1);
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
    expect(ctx.heard(ctx.sources[0] as FakeSource)).toBe(1);
  });
});

describe("synth mode setup failures", () => {
  it("tears the first engine down and plays from files when a later engine cannot start", async () => {
    const link = FakeWorkletNode.hook;
    let made = 0;
    FakeWorkletNode.hook = (node) => {
      made += 1;
      if (made === 2) {
        node.port.emit({ message: "no audio thread", type: "error" });
      } else {
        link?.(node);
      }
    };
    vi.stubGlobal(
      "fetch",
      fakeFetch({ "/audio/coin.ogg": audioBytes(0.3) }).fn
    );
    const p = await make();
    expect(errors.map((e) => e.message)).toEqual(["no audio thread"]);
    const [first] = FakeWorkletNode.instances;
    expect(first?.port.closed).toBe(true);
    expect(first?.reaches(ctx.destination)).toBe(false);
    // the sound still plays, from its file, through the player's buses
    p.sfx("coin");
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.heard(ctx.sources[0] as FakeSource)).toBe(1);
  });
});

describe("synth mode sound effects", () => {
  it("loads the document once, then triggers with the game's options", async () => {
    const p = await make();
    const h = p.sfx("coin", { pan: -1, pitch: 2, velocity: 0.5 });
    p.sfx("coin");
    const sfx = sfxEngine();
    expect(namesOf(sfx)).toEqual(["loadSfx", "trigger", "trigger"]);
    expect(callsOf(sfx)[0]).toEqual(["loadSfx", "coin", { name: "coin" }]);
    expect(callsOf(sfx)[1]).toEqual([
      "trigger",
      "coin",
      { pan: -1, pitch: 2, velocity: 0.5 },
    ]);
    expect(callsOf(sfx)[2]).toEqual(["trigger", "coin", {}]);
    expect(h.id).toBe("coin");
  });

  it("releases the voice it started", async () => {
    const p = await make();
    p.sfx("coin");
    const h = p.sfx("coin");
    h.stop();
    expect(callsOf(sfxEngine()).at(-1)).toEqual(["release", 2]);
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
    expect(ctx.heard(ctx.sources[0] as FakeSource)).toBe(1);
    expect(namesOf(sfxEngine())).not.toContain("trigger");
  });

  it("preloads documents into the engine", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch({ "/audio/laser.ogg": audioBytes(0.4) }).fn
    );
    const p = await make();
    await p.preload();
    expect(namesOf(sfxEngine())).toEqual(["loadSfx"]);
  });

  it("is heard: the engine renders the sound and it reaches the speakers through the sfx bus and master", async () => {
    const p = await make({ buses: { master: 0.8, sfx: 0.5 } });
    expect(heardLevel(ctx, sfxEngine())).toBe(0);
    p.sfx("coin");
    rig.runBlocks(ctx, 4);
    const sfx = sfxEngine();
    // the fake engine renders a 0.1 sine while a voice is held; the buses scale it
    expect(sfx.peak).toBeGreaterThan(0.05);
    expect(heardLevel(ctx, sfx)).toBeCloseTo(sfx.peak * 0.5 * 0.8, 9);
    // the idle music engine adds nothing
    expect(heardLevel(ctx, musicEngine())).toBe(0);
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

  it("places a batch of events on the time line with the clock pair that batch carries", async () => {
    const p = await make();
    const seen: number[] = [];
    p.on("noteOn", (e) => seen.push(e.time));
    const { node } = musicEngine();
    // the last clock disagrees with the batch (as it can by a little under load): the batch's own pair is the truth
    node.port.emit({
      frame: 0,
      playing: true,
      position: null,
      time: 0,
      type: "clock",
    });
    node.port.emit({
      clockFrame: 48_000,
      clockTime: 3,
      events: [
        {
          channel: 0,
          channelId: "pulse1",
          frame: 48_000 + 4800,
          hz: 440,
          id: "lead",
          note: 69,
          order: -1,
          row: -1,
          type: "noteOn",
          velocity: 1,
        },
      ],
      type: "events",
    });
    ctx.currentTime = 10;
    vi.advanceTimersByTime(10);
    // 3 s + 0.1 s after the pair's frame, plus the 50 ms output latency
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeCloseTo(3.15, 9);
  });

  it("reports an error from the worklet and keeps playing", async () => {
    const p = await make();
    p.sfx("coin");
    FakeWorkletNode.instances[0]?.port.emit({ message: "boom", type: "error" });
    expect(errors.map((e) => e.message)).toEqual(["worklet: boom"]);
    p.sfx("coin");
    expect(namesOf(sfxEngine()).filter((n) => n === "trigger")).toHaveLength(2);
  });
});

describe("synth mode music", () => {
  it("loads the song and plays it from a row, with the song's own loop", async () => {
    const p = await make();
    ctx.currentTime = 1;
    const h = await p.music("title", { fadeIn: 1, startAt: 2 });
    const music = musicEngine();
    expect(namesOf(music)).toEqual(["loadSong", "play"]);
    expect(callsOf(music)[1]).toEqual([
      "play",
      { loop: true, order: 1, row: 0 },
    ]);
    // faded in from silence over the second after it started
    expect(gainOf(music, 1)).toBe(0);
    expect(gainOf(music, 1.5)).toBeCloseTo(0.5, 9);
    expect(gainOf(music, 2)).toBe(1);
    // the engine reports the position in its clock
    rig.runBlocks(ctx, 2);
    expect(h.position()).toMatchObject({ order: 1, row: 0 });
  });

  it("is heard: the song renders and reaches the speakers through the music bus and master", async () => {
    rig = linkWorklets({ songFrames: 128 * 200 });
    const p = await make({ buses: { master: 0.8, music: 0.5 } });
    await p.music("title");
    rig.runBlocks(ctx, 4);
    const music = musicEngine();
    expect(music.peak).toBeGreaterThan(0.05);
    expect(heardLevel(ctx, music)).toBeCloseTo(music.peak * 0.5 * 0.8, 9);
    expect(heardLevel(ctx, sfxEngine())).toBe(0);
  });

  it("does not loop a song without a loop section, unless asked", async () => {
    const p = await make();
    await p.music("boss");
    expect(callsOf(musicEngine())[1]).toEqual(["play", { loop: false }]);
    const second = p.music("boss", { loop: true });
    await vi.advanceTimersByTimeAsync(100);
    await second;
    expect(
      callsOf(musicEngine())
        .filter((c) => c[0] === "play")
        .at(-1)
    ).toEqual(["play", { loop: true }]);
  });

  it("fades the old song out before the next one replaces it, and the next one is heard", async () => {
    const p = await make();
    ctx.currentTime = 5;
    await p.music("title");
    const music = musicEngine();
    const next = p.music("boss", { fadeIn: 0 });
    // the old song is on its way down: full at the start of the switch, silent 40 ms later
    expect(gainOf(music, 5)).toBe(1);
    expect(gainOf(music, 5.02)).toBeCloseTo(0.5, 9);
    expect(gainOf(music, 5.04)).toBe(0);
    expect(namesOf(music)).toEqual(["loadSong", "play"]);
    ctx.currentTime = 5.1;
    await vi.advanceTimersByTimeAsync(100);
    await next;
    expect(namesOf(music)).toEqual([
      "loadSong",
      "play",
      "stop",
      "loadSong",
      "play",
    ]);
    // the fade the switch left behind must not still be holding the new song silent
    expect(gainOf(music, 5.1)).toBe(1);
  });

  it("stops after the fade out, unless a new song took over meanwhile", async () => {
    const p = await make();
    const music = musicEngine();
    await p.music("title");
    p.stopMusic({ fadeOut: 0.5 });
    expect(namesOf(music)).toEqual(["loadSong", "play"]);
    await vi.advanceTimersByTimeAsync(600);
    expect(namesOf(music)).toEqual(["loadSong", "play", "stop"]);

    await p.music("boss");
    p.stopMusic({ fadeOut: 0.5 });
    await vi.advanceTimersByTimeAsync(100);
    await p.music("title");
    await vi.advanceTimersByTimeAsync(600);
    // the stop scheduled for the first boss run never hits the newer title
    expect(namesOf(music).filter((n) => n === "stop")).toHaveLength(1);
  });

  it("is silent after a fade out, and a song started afterwards is heard again", async () => {
    rig = linkWorklets({ songFrames: 128 * 400 });
    const p = await make();
    const music = musicEngine();
    await p.music("title");
    p.stopMusic({ fadeOut: 0.5 });
    await vi.advanceTimersByTimeAsync(600);
    expect(gainOf(music, 0.5)).toBe(0);
    rig.runBlocks(ctx, 2);
    expect(music.peak).toBe(0);
    ctx.currentTime = 2;
    await p.music("boss");
    expect(gainOf(music, 2)).toBe(1);
    rig.runBlocks(ctx, 4);
    expect(heardLevel(ctx, music)).toBeGreaterThan(0.05);
  });

  it("stops through the handle only while it is current", async () => {
    const p = await make();
    const h = await p.music("title");
    h.stop();
    h.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(namesOf(musicEngine()).filter((n) => n === "stop")).toHaveLength(1);
    expect(h.position()).toBeNull();
  });

  it("knows when the song ended by itself, so the next one starts at once", async () => {
    const p = await make();
    await p.music("boss");
    rig.runBlocks(ctx, 25);
    // a pending switch would wait on a timer; with fake timers that would hang this await
    await expect(p.music("title")).resolves.toMatchObject({ id: "title" });
    expect(namesOf(musicEngine()).filter((n) => n === "loadSong")).toHaveLength(
      2
    );
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
    const music = musicEngine();
    await p.music("odd");
    const fileSource = ctx.sources.at(-1) as FakeSource;
    expect(ctx.heard(fileSource)).toBe(1);
    await p.music("title");
    // the file song is cut and the synth song is the one heard
    expect(ctx.heard(fileSource, 0.05)).toBe(0);
    expect(gainOf(music, 0.05)).toBe(1);
    await p.music("odd");
    await vi.advanceTimersByTimeAsync(100);
    expect(namesOf(music)).toContain("stop");
    expect(gainOf(music, 0.05)).toBe(0);
    expect(ctx.heard(ctx.sources.at(-1) as FakeSource, 0.05)).toBe(1);
  });

  it("fades the song it replaces over the new song's fade in, whichever side plays it", async () => {
    vi.stubGlobal("fetch", fakeFetch({ "/audio/odd.ogg": audioBytes(50) }).fn);
    const mixed = {
      ...manifest,
      songs: {
        ...manifest.songs,
        odd: { duration: 50, file: "odd.ogg", loopEnd: null, loopStart: null },
      },
    };
    const p = (await make({ manifest: mixed })) as BleepPlayer;
    const music = musicEngine();
    await p.music("odd");
    const fileSource = ctx.sources.at(-1) as FakeSource;
    // file song -> synth song: the file song fades out as the synth song fades in
    ctx.currentTime = 10;
    await p.music("title", { fadeIn: 2 });
    expect([10, 11, 12].map((t) => ctx.heard(fileSource, t))).toEqual([
      1, 0.5, 0,
    ]);
    expect([10, 11, 12].map((t) => gainOf(music, t))).toEqual([0, 0.5, 1]);
    // synth song -> file song
    ctx.currentTime = 20;
    await p.music("odd", { fadeIn: 2 });
    const second = ctx.sources.at(-1) as FakeSource;
    expect([20, 21, 22].map((t) => gainOf(music, t))).toEqual([1, 0.5, 0]);
    expect([20, 21, 22].map((t) => ctx.heard(second, t))).toEqual([0, 0.5, 1]);
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

describe("synth mode volume and mute", () => {
  it("silences both engines when muted and brings them back when unmuted", async () => {
    rig = linkWorklets({ songFrames: 128 * 400 });
    const p = await make({ buses: { master: 0.8 } });
    p.sfx("coin");
    await p.music("title");
    rig.runBlocks(ctx, 2);
    expect(heardLevel(ctx, sfxEngine())).toBeGreaterThan(0.05);
    expect(heardLevel(ctx, musicEngine())).toBeGreaterThan(0.05);

    p.mute(true);
    // the 10 ms ramp is over after four blocks
    rig.runBlocks(ctx, 6);
    expect(sfxEngine().peak).toBeGreaterThan(0.05);
    expect(heardLevel(ctx, sfxEngine())).toBe(0);
    expect(heardLevel(ctx, musicEngine())).toBe(0);

    p.mute(false);
    rig.runBlocks(ctx, 6);
    expect(heardLevel(ctx, sfxEngine())).toBeCloseTo(sfxEngine().peak * 0.8, 9);
    expect(heardLevel(ctx, musicEngine())).toBeCloseTo(
      musicEngine().peak * 0.8,
      9
    );
    expect(heardLevel(ctx, sfxEngine())).toBeGreaterThan(0.05);
  });

  it("applies bus volumes to what the engines render", async () => {
    rig = linkWorklets({ songFrames: 128 * 400 });
    const p = await make();
    p.sfx("coin");
    await p.music("title");
    p.setVolume("sfx", 0.5, 0);
    p.setVolume("music", 0.25, 0);
    rig.runBlocks(ctx, 2);
    expect(gainOf(sfxEngine())).toBe(0.5);
    expect(gainOf(musicEngine())).toBe(0.25);
    p.setVolume("master", 0, 0);
    expect(heardLevel(ctx, sfxEngine())).toBe(0);
    expect(heardLevel(ctx, musicEngine())).toBe(0);
  });
});

describe("synth mode teardown", () => {
  it("disposes the engines and stops routing them to the speakers", async () => {
    const p = await make();
    p.dispose();
    for (const node of FakeWorkletNode.instances) {
      expect(node.port.closed).toBe(true);
      expect(node.disconnected).toBe(true);
      expect(node.reaches(ctx.destination)).toBe(false);
    }
  });
});
