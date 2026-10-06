import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlayer } from "../src/player.ts";
import type { AudioManifest, BleepPlayer } from "../src/types.ts";
import {
  audioBytes,
  FakeContext,
  type FakeSource,
  fakeFetch,
} from "./fake-audio.ts";

const manifest = {
  base: "/audio/",
  sampleRate: 48_000,
  sfx: {
    coin: { duration: 0.3, file: "coin.ogg" },
    laser: { duration: 0.4, file: "laser.ogg" },
  },
  songs: {
    boss: { duration: 12, file: "boss.ogg", loopEnd: null, loopStart: null },
    title: {
      duration: 25,
      events: "title.events.json",
      file: "title.ogg",
      loopEnd: 24,
      loopStart: 4.8,
    },
  },
} satisfies AudioManifest;

const RATE = 48_000;
const ev = (type: string, seconds: number, extra: object = {}) => ({
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
});

const files = () => ({
  "/audio/boss.ogg": audioBytes(12),
  "/audio/coin.ogg": audioBytes(0.3),
  "/audio/laser.ogg": audioBytes(0.4),
  "/audio/title.events.json": [
    ev("noteOn", 1),
    ev("row", 1, { id: "intro", order: 0, row: 8 }),
    ev("noteOn", 6),
    ev("noteOn", 30),
  ],
  "/audio/title.ogg": audioBytes(25),
});

let ctx: FakeContext;
let errors: Error[];
let fetchStub: ReturnType<typeof fakeFetch>;

async function make(opts: Partial<Parameters<typeof createPlayer>[0]> = {}) {
  const player = await createPlayer({
    context: ctx.asContext(),
    manifest,
    onError: (e) => errors.push(e),
    unlockOnGesture: false,
    ...opts,
  });
  return player;
}

const lastSource = () => ctx.sources.at(-1) as FakeSource;
/** Level of a source at the speakers: its own gain times every bus gain on the way out, 0 once it stopped sounding. */
const heard = (source: FakeSource, at = ctx.currentTime) =>
  ctx.heard(source, at);

beforeEach(() => {
  vi.useFakeTimers();
  ctx = new FakeContext();
  errors = [];
  fetchStub = fakeFetch(files());
  vi.stubGlobal("fetch", fetchStub.fn);
  vi.stubGlobal(
    "Audio",
    class {
      canPlayType() {
        return "maybe";
      }
    }
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("buses and volume", () => {
  it("lets sfx and music out of the speakers at full level by default", async () => {
    const p = await make();
    await p.preload();
    p.sfx("coin");
    const sfx = lastSource();
    await p.music("boss");
    const music = lastSource();
    expect(heard(sfx)).toBe(1);
    expect(heard(music)).toBe(1);
  });

  it("applies the initial bus volumes: sound x its bus x master", async () => {
    const p = await make({ buses: { master: 0.9, music: 0.5, sfx: 0.25 } });
    await p.preload();
    p.sfx("coin", { velocity: 0.5 });
    const sfx = lastSource();
    await p.music("boss");
    const music = lastSource();
    expect(heard(sfx)).toBeCloseTo(0.5 * 0.25 * 0.9, 9);
    expect(heard(music)).toBeCloseTo(0.5 * 0.9, 9);
  });

  it("clamps the initial bus volumes to 0..1", async () => {
    const p = await make({ buses: { master: 4, sfx: -1 } });
    await p.preload();
    p.sfx("coin");
    const sfx = lastSource();
    await p.music("boss");
    expect(heard(sfx)).toBe(0);
    expect(heard(lastSource())).toBe(1);
  });

  it("ramps a bus from its current level to the new one over the given time", async () => {
    const p = await make();
    await p.music("boss");
    const music = lastSource();
    ctx.currentTime = 4;
    p.setVolume("music", 0.4, 1);
    expect(heard(music, 4)).toBe(1);
    expect(heard(music, 4.5)).toBeCloseTo(0.7, 9);
    expect(heard(music, 5)).toBeCloseTo(0.4, 9);
    expect(heard(music, 9)).toBeCloseTo(0.4, 9);
  });

  it("moves a bus in a tiny default ramp, clamps to 0..1, and a zero ramp is immediate", async () => {
    const p = await make();
    await p.preload();
    p.sfx("coin", { loop: true });
    const sfx = lastSource();
    ctx.currentTime = 4;
    p.setVolume("sfx", 0.5);
    // no jump at the instant of the change (a click), but settled within a few milliseconds
    expect(heard(sfx, 4)).toBe(1);
    expect(heard(sfx, 4.005)).toBeGreaterThan(0.5);
    expect(heard(sfx, 4.005)).toBeLessThan(1);
    expect(heard(sfx, 4.01)).toBeCloseTo(0.5, 9);
    p.setVolume("sfx", 3);
    expect(heard(sfx, 5)).toBe(1);
    p.setVolume("sfx", -2);
    expect(heard(sfx, 5)).toBe(0);
    p.setVolume("sfx", 0.5, 0);
    expect(heard(sfx, 4)).toBe(0.5);
  });

  it("continues a fade that is interrupted from the level it had reached", async () => {
    const p = await make();
    await p.music("boss");
    const music = lastSource();
    p.setVolume("music", 0, 2);
    ctx.currentTime = 1;
    expect(heard(music)).toBeCloseTo(0.5, 9);
    p.setVolume("music", 1, 1);
    expect(heard(music, 1)).toBeCloseTo(0.5, 9);
    expect(heard(music, 1.5)).toBeCloseTo(0.75, 9);
    expect(heard(music, 2)).toBeCloseTo(1, 9);
  });

  it("changes the volume of sounds that are already playing", async () => {
    const p = await make();
    await p.preload();
    p.sfx("coin", { loop: true });
    const sfx = lastSource();
    await p.music("boss");
    const music = lastSource();
    p.setVolume("master", 0.5, 0);
    p.setVolume("sfx", 0.5, 0);
    expect(heard(sfx)).toBe(0.25);
    expect(heard(music)).toBe(0.5);
  });

  it("mutes everything and restores each bus and the latest master volume when unmuted", async () => {
    const p = await make({ buses: { master: 0.8, sfx: 0.5 } });
    await p.preload();
    p.sfx("coin", { loop: true });
    const sfx = lastSource();
    await p.music("boss");
    const music = lastSource();
    expect(heard(sfx)).toBeCloseTo(0.4, 9);
    ctx.currentTime = 1;
    p.mute(true);
    // a short ramp, then silence on every route to the speakers
    expect(heard(sfx, 1.02)).toBe(0);
    expect(heard(music, 1.02)).toBe(0);
    // the master volume changed while muted is what comes back
    p.setVolume("master", 0.6);
    expect(heard(sfx, 1.1)).toBe(0);
    ctx.currentTime = 2;
    p.mute(false);
    expect(heard(sfx, 2.02)).toBeCloseTo(0.5 * 0.6, 9);
    expect(heard(music, 2.02)).toBeCloseTo(0.6, 9);
  });
});

describe("context", () => {
  it("resumes only when the context is not running", async () => {
    const p = await make();
    await p.resume();
    await p.resume();
    expect(ctx.resumes).toBe(1);
  });

  it("resumes on the first user gesture and then lets go of the listeners", async () => {
    await make({ unlockOnGesture: true });
    document.dispatchEvent(new Event("pointerup"));
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.resumes).toBe(1);
    expect(ctx.state).toBe("running");
    document.dispatchEvent(new Event("keydown"));
    document.dispatchEvent(new Event("click"));
    expect(ctx.resumes).toBe(1);
  });

  it("creates its own context when none is given and closes it on dispose", async () => {
    const made: FakeContext[] = [];
    vi.stubGlobal(
      "AudioContext",
      class extends FakeContext {
        constructor(options?: unknown) {
          super(options);
          made.push(this);
        }
      }
    );
    const p = await createPlayer({
      onError: (e) => errors.push(e),
      unlockOnGesture: false,
    });
    expect(made).toHaveLength(1);
    expect(made[0]?.options).toEqual({ latencyHint: "interactive" });
    expect(p.context).toBe(made[0] as unknown);
    p.dispose();
    expect(made[0]?.closed).toBe(true);
  });

  it("leaves a context it was given open, but routes nothing to its speakers any more", async () => {
    const p = await make();
    await p.preload();
    p.sfx("coin", { loop: true });
    const source = lastSource();
    expect(source.reaches(ctx.destination)).toBe(true);
    p.dispose();
    expect(ctx.closed).toBe(false);
    expect(source.reaches(ctx.destination)).toBe(false);
  });
});

describe("sound effects", () => {
  let p: BleepPlayer<keyof typeof manifest.sfx, keyof typeof manifest.songs>;
  beforeEach(async () => {
    p = await make();
  });

  it("plays a preloaded file through gain, pan and rate out of the speakers", async () => {
    await p.preload(["coin"]);
    expect(fetchStub.requested).toEqual(["/audio/coin.ogg"]);
    const handle = p.sfx("coin", { pan: -0.5, pitch: 12, velocity: 0.5 });
    const source = lastSource();
    expect(source.buffer?.duration).toBeCloseTo(0.3, 9);
    expect(source.playbackRate.value).toBe(2);
    expect(source.loop).toBe(false);
    // velocity is the only attenuation with the buses at unity
    expect(heard(source)).toBeCloseTo(0.5, 9);
    const [panner] = ctx.panners;
    expect(panner?.pan.value).toBe(-0.5);
    expect(source.reaches(panner as NonNullable<typeof panner>)).toBe(true);
    expect(panner?.reaches(ctx.destination)).toBe(true);
    expect(handle).toMatchObject({ id: "coin" });
    expect(handle.handle).toBeGreaterThan(0);
  });

  it("plays centered without any pan, and loops on request", async () => {
    await p.preload();
    p.sfx("laser", { loop: true });
    const source = lastSource();
    expect(source.loop).toBe(true);
    expect(ctx.panners.every((x) => x.pan.value === 0)).toBe(true);
    // 10 s into a 0.4 s file it is still sounding, at full level
    expect(heard(source, 10)).toBe(1);
  });

  it("gives each play its own handle number", async () => {
    await p.preload();
    const a = p.sfx("coin");
    const b = p.sfx("coin");
    expect(b.handle).not.toBe(a.handle);
  });

  it("loads on first use and plays once the file has arrived", async () => {
    p.sfx("coin");
    expect(ctx.sources).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.sources).toHaveLength(1);
    expect(heard(lastSource())).toBe(1);
    // the second play is instant
    p.sfx("coin");
    expect(ctx.sources).toHaveLength(2);
    expect(fetchStub.requested).toEqual(["/audio/coin.ogg"]);
  });

  it("does not play a sound stopped before its file arrived", async () => {
    const h = p.sfx("coin");
    h.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.sources).toHaveLength(0);
  });

  it("drops a sound whose file arrives more than a second late", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal("fetch", async (url: string) => {
      await gate;
      return fetchStub.fn(url);
    });
    p.sfx("coin");
    ctx.currentTime = 2;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.sources).toHaveLength(0);
    // but it is cached now
    p.sfx("coin");
    expect(ctx.sources).toHaveLength(1);
  });

  it("stops a voice with a short fade", async () => {
    await p.preload();
    ctx.currentTime = 3;
    const h = p.sfx("coin", { loop: true, velocity: 0.8 });
    h.stop();
    const source = lastSource();
    // no jump at the instant of the stop, a straight fade to silence, then the source is released
    expect(heard(source, 3)).toBeCloseTo(0.8, 9);
    expect(heard(source, 3.004)).toBeCloseTo(0.4, 9);
    expect(heard(source, 3.008)).toBeCloseTo(0, 9);
    expect(source.soundingAt(3.02)).toBe(false);
  });

  it("allows 4 instances per id and stops the oldest beyond that", async () => {
    await p.preload();
    for (let i = 0; i < 5; i += 1) {
      p.sfx("coin");
    }
    const coins = [...ctx.sources];
    expect(coins).toHaveLength(5);
    // after the quick fade only the oldest is gone (the files are 0.3 s long, so nothing ended by itself)
    ctx.currentTime = 0.05;
    expect(coins.map((s) => heard(s))).toEqual([0, 1, 1, 1, 1]);
    p.sfx("laser");
    expect(heard(lastSource())).toBe(1);
    expect(ctx.soundingCount()).toBe(5);
  });

  it("caps all sound effects together and stops the oldest first", async () => {
    const small = await make({ maxInstancesPerSfx: 10, maxSfxVoices: 3 });
    await small.preload();
    small.sfx("coin");
    small.sfx("laser");
    small.sfx("coin");
    small.sfx("laser");
    ctx.currentTime = 0.05;
    expect(ctx.sources.map((s) => heard(s))).toEqual([0, 1, 1, 1]);
  });

  it("frees a slot when a voice ends by itself", async () => {
    await p.preload();
    for (let i = 0; i < 4; i += 1) {
      p.sfx("coin");
    }
    const first = ctx.sources[0] as FakeSource;
    first.finish();
    expect(first.disconnected).toBe(true);
    p.sfx("coin");
    // room was made by the voice that ended: nobody else was cut, and the ended one was not touched again
    ctx.currentTime = 0.05;
    expect(ctx.soundingCount()).toBe(4);
    expect(ctx.sources.every((s) => s.stops.length === 0)).toBe(true);
  });

  it("reports an unknown id and hands back an inert handle", () => {
    // a mistake the types would catch, made at runtime
    const h = (p as BleepPlayer).sfx("missing");
    expect(errors.map((e) => e.message)).toEqual(['unknown sfx "missing"']);
    expect(h.id).toBe("missing");
    expect(() => h.stop()).not.toThrow();
    expect(ctx.sources).toHaveLength(0);
  });

  it("reports a file that cannot be fetched", async () => {
    fetchStub = fakeFetch({});
    vi.stubGlobal("fetch", fetchStub.fn);
    p.sfx("coin");
    await vi.advanceTimersByTimeAsync(0);
    expect(errors[0]?.message).toBe("could not load /audio/coin.ogg: 404");
    // a failed load is not cached: the next play tries again
    p.sfx("coin");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchStub.requested).toEqual(["/audio/coin.ogg", "/audio/coin.ogg"]);
  });

  it("explains an OGG file a Safari-like browser cannot decode", async () => {
    vi.stubGlobal(
      "Audio",
      class {
        canPlayType() {
          return "";
        }
      }
    );
    ctx.decodeFails = true;
    p.sfx("coin");
    await vi.advanceTimersByTimeAsync(0);
    expect(errors[0]?.message).toContain(
      "could not decode sfx:coin (coin.ogg)"
    );
    expect(errors[0]?.message).toContain("cannot decode OGG Vorbis");
  });

  it("announces trigger events when the sound becomes audible", async () => {
    await p.preload();
    const seen: { time: number; id: string; channel: number; type: string }[] =
      [];
    p.on("trigger", (e) => seen.push(e));
    ctx.currentTime = 1;
    p.sfx("coin", { velocity: 0.7 });
    ctx.currentTime = 1.02;
    vi.advanceTimersByTime(20);
    expect(seen).toEqual([]);
    ctx.currentTime = 1.06;
    vi.advanceTimersByTime(20);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      channel: -1,
      id: "coin",
      time: 1.05,
      type: "trigger",
      velocity: 0.7,
    });
    // the timer rests once nothing is left to deliver
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("music", () => {
  let p: BleepPlayer<keyof typeof manifest.sfx, keyof typeof manifest.songs>;
  beforeEach(async () => {
    p = await make();
  });

  it("loops the song's loop section on the source itself", async () => {
    ctx.currentTime = 2;
    const handle = await p.music("title");
    const source = lastSource();
    expect(source.loop).toBe(true);
    expect(source.loopStart).toBe(4.8);
    expect(source.loopEnd).toBe(24);
    expect(source.starts).toEqual([{ offset: 0, when: 2 }]);
    // audible at full level, and still going long after the 25 s file would have run out
    expect(heard(source)).toBe(1);
    expect(heard(source, 200)).toBe(1);
    expect(handle.id).toBe("title");
  });

  it("fades in, starts at an offset, and can turn the loop off or on", async () => {
    ctx.currentTime = 5;
    await p.music("title", { fadeIn: 2, loop: false, startAt: 7.5 });
    const source = lastSource();
    expect(source.loop).toBe(false);
    expect(source.starts).toEqual([{ offset: 7.5, when: 5 }]);
    expect(heard(source, 5)).toBe(0);
    expect(heard(source, 6)).toBeCloseTo(0.5, 9);
    expect(heard(source, 7)).toBe(1);

    await p.music("boss");
    expect(lastSource().loop).toBe(false);
    await p.music("boss", { loop: true });
    expect(lastSource().loop).toBe(true);
    expect(lastSource().loopStart).toBe(0);
    expect(lastSource().loopEnd).toBe(12);
  });

  it("never starts past the loop end", async () => {
    await p.music("title", { startAt: 24.5 });
    expect(lastSource().starts[0]?.offset).toBe(4.8);
  });

  it("crossfades into the next song over its fade in", async () => {
    ctx.currentTime = 1;
    await p.music("title");
    const first = lastSource();
    ctx.currentTime = 10;
    await p.music("boss", { fadeIn: 3 });
    const next = lastSource();
    // over the new song's fade in (3 s from t = 10) the old one falls from full to silence and the new one rises
    expect([10, 11.5, 13].map((t) => heard(first, t))).toEqual([1, 0.5, 0]);
    expect([10, 11.5, 13].map((t) => heard(next, t))).toEqual([0, 0.5, 1]);
    // the old source is released once it is silent
    expect(first.soundingAt(13.02)).toBe(false);
    expect(next.soundingAt(13.02)).toBe(true);
  });

  it("stops music with a fade out, from the level it had reached in a fade in", async () => {
    ctx.currentTime = 0;
    await p.music("title", { fadeIn: 4 });
    const source = lastSource();
    ctx.currentTime = 1;
    p.stopMusic({ fadeOut: 2 });
    // a quarter of the way up the fade in when it was interrupted, then down to silence at t = 3
    expect(heard(source, 1)).toBeCloseTo(0.25, 9);
    expect(heard(source, 2)).toBeCloseTo(0.125, 9);
    expect(heard(source, 3)).toBe(0);
    expect(source.soundingAt(3.02)).toBe(false);
  });

  it("stops at once but without a click when no fade is given", async () => {
    await p.music("boss");
    const source = lastSource();
    ctx.currentTime = 2;
    p.stopMusic();
    expect(heard(source, 2)).toBe(1);
    expect(heard(source, 2.004)).toBeCloseTo(0.5, 9);
    expect(heard(source, 2.008)).toBe(0);
    expect(source.soundingAt(2.02)).toBe(false);
  });

  it("stops through the handle, but only while it is the current song", async () => {
    const first = await p.music("title");
    const second = await p.music("boss");
    const current = lastSource();
    ctx.currentTime = 1;
    // the first song was replaced: its handle must not cut the song that is playing now
    first.stop({ fadeOut: 1 });
    ctx.currentTime = 3;
    expect(heard(current)).toBe(1);
    second.stop();
    ctx.currentTime = 3.05;
    expect(heard(current)).toBe(0);
  });

  it("lets the newest request win while a song is still loading", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = fakeFetch(files());
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("title.ogg")) {
        await gate;
      }
      return slow.fn(url);
    });
    const first = p.music("title");
    const second = await p.music("boss");
    release();
    const late = await first;
    expect(late.position()).toBeNull();
    expect(ctx.sources.filter((s) => s.starts.length > 0)).toHaveLength(1);
    expect(second.id).toBe("boss");
  });

  it("cancels a loading song when music is stopped", async () => {
    const pending = p.music("boss");
    p.stopMusic();
    await pending;
    expect(ctx.sources.filter((s) => s.starts.length > 0)).toHaveLength(0);
  });

  it("reports an unknown song and a song that cannot be decoded", async () => {
    const h = await (p as BleepPlayer).music("nope");
    expect(h.position()).toBeNull();
    expect(errors[0]?.message).toBe('unknown song "nope"');
    ctx.decodeFails = true;
    await p.music("boss");
    expect(errors[1]?.message).toContain("could not decode songs:boss");
    expect(ctx.sources.filter((s) => s.starts.length > 0)).toHaveLength(0);
  });
});

describe("music events from the events file", () => {
  it("replays notes and rows against the source's start and follows the loop", async () => {
    const p = await make();
    const seen: string[] = [];
    for (const type of ["noteOn", "row", "loop", "end"] as const) {
      p.on(type, (e) => seen.push(`${type}@${e.time.toFixed(2)}`));
    }
    ctx.currentTime = 10;
    const handle = await p.music("title");
    expect(handle.position()).toBeNull();

    ctx.currentTime = 11.04;
    vi.advanceTimersByTime(10);
    expect(seen).toEqual([]);
    ctx.currentTime = 11.06;
    vi.advanceTimersByTime(10);
    expect(seen).toEqual(["noteOn@11.05", "row@11.05"]);
    expect(handle.position()).toEqual({ order: 0, pulse: -1, row: 8, tick: 0 });

    // the intro note at 6 s (inside the loop section 4.8 to 24), then the wrap at 24 s
    ctx.currentTime = 16.06;
    vi.advanceTimersByTime(10);
    expect(seen.at(-1)).toBe("noteOn@16.05");
    ctx.currentTime = 34.06;
    vi.advanceTimersByTime(10);
    expect(seen.at(-1)).toBe("loop@34.05");
    // the pass after the wrap replays the in-loop notes only: 6 s again, never the tail note at 30 s
    ctx.currentTime = 34.05 + 1.2 + 0.01;
    vi.advanceTimersByTime(10);
    expect(seen.at(-1)).toBe("noteOn@35.25");
    expect(seen.filter((s) => s.startsWith("noteOn"))).toHaveLength(3);
  });

  it("stops replaying when the song is stopped", async () => {
    const p = await make();
    const seen: number[] = [];
    p.on("noteOn", (e) => seen.push(e.time));
    ctx.currentTime = 0;
    const h = await p.music("title");
    h.stop();
    ctx.currentTime = 50;
    vi.advanceTimersByTime(50);
    expect(seen).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fires end when a song without a loop plays through to the end of its file", async () => {
    const p = await make();
    const seen: string[] = [];
    p.on("end", (e) => seen.push(`end@${e.time.toFixed(2)}`));
    ctx.currentTime = 0;
    await p.music("title", { loop: false });
    // the 25 s file ends at t = 25, heard 50 ms later
    ctx.currentTime = 25.04;
    vi.advanceTimersByTime(10);
    expect(seen).toEqual([]);
    ctx.currentTime = 25.06;
    vi.advanceTimersByTime(10);
    expect(seen).toEqual(["end@25.05"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("plays a song without an events file: nothing is fetched for it and nothing is announced", async () => {
    const p = await make();
    const seen: string[] = [];
    p.on("end", (e) => seen.push(`end@${e.time.toFixed(2)}`));
    ctx.currentTime = 0;
    await p.music("boss");
    ctx.currentTime = 20;
    vi.advanceTimersByTime(50);
    expect(seen).toEqual([]);
    expect(fetchStub.requested.filter((u) => u.endsWith(".json"))).toEqual([]);
  });

  it("survives an events file that is missing or broken", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch({ ...files(), "/audio/title.events.json": { nope: true } }).fn
    );
    const p = await make();
    await expect(p.music("title")).resolves.toMatchObject({ id: "title" });
    expect(errors).toEqual([]);
  });
});

describe("preload and dispose", () => {
  it("decodes the listed ids, or everything, and joins a base without a slash", async () => {
    const p = await make({ manifest: { ...manifest, base: "/audio" } });
    await p.preload(["laser"]);
    expect(fetchStub.requested).toEqual(["/audio/laser.ogg"]);
    await p.preload();
    expect(
      fetchStub.requested.filter((u) => u.endsWith("laser.ogg"))
    ).toHaveLength(1);
    expect(fetchStub.requested).toContain("/audio/title.ogg");
    expect(fetchStub.requested).toContain("/audio/title.events.json");
    expect(ctx.modules).toEqual([]);
  });

  it("rejects preload when a file is missing", async () => {
    vi.stubGlobal("fetch", fakeFetch({}).fn);
    const p = await make();
    await expect(p.preload(["coin"])).rejects.toThrow(
      "could not load /audio/coin.ogg"
    );
  });

  it("stops everything on dispose, quietly", async () => {
    const p = await make();
    await p.preload();
    p.sfx("coin", { loop: true });
    await p.music("boss");
    expect(ctx.soundingCount()).toBe(2);
    p.dispose();
    p.dispose();
    ctx.currentTime = 0.1;
    // the buses are cut loose, but the sources themselves are stopped too: a looping source would play on forever
    expect(ctx.sources.some((s) => s.soundingAt(0.1))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    // a call after dispose does not throw or start anything
    const before = ctx.sources.length;
    p.sfx("coin");
    expect(ctx.sources).toHaveLength(before);
  });

  it("warns once at creation about OGG files Safari cannot decode", async () => {
    vi.stubGlobal(
      "Audio",
      class {
        canPlayType() {
          return "";
        }
      }
    );
    await make();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("OGG");
  });

  it("works with no manifest and reports ids as unknown", async () => {
    const p = await createPlayer({
      context: ctx.asContext(),
      onError: (e) => errors.push(e),
      unlockOnGesture: false,
    });
    p.sfx("anything");
    expect((await p.music("anything")).id).toBe("anything");
    expect(errors).toHaveLength(2);
  });

  it("falls back to console.warn for problems when no handler is given", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const p = await createPlayer({
      context: ctx.asContext(),
      unlockOnGesture: false,
    });
    p.sfx("x");
    expect(warn).toHaveBeenCalledWith('bleepkit: unknown sfx "x"');
    warn.mockRestore();
  });
});
