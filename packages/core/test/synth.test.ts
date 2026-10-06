/* The realtime Synth API (section 4.1): transport, sfx voices, manual notes, mute and solo, master, scopes, events. */

import { describe, expect, it } from "vitest";
import { createScopeRings, scopeBufferBytes } from "../src/engine/scope.ts";
import type { Instrument, Sfx, Synth } from "../src/index.ts";
import {
  createScopeReader,
  createSynth,
  normalizeInstrument,
  normalizeSfx,
} from "../src/index.ts";
import {
  fixtureDemo,
  fixtureInstruments,
  fixtureJson,
  fixtureSfx,
  fixtureSong,
  hashChannels,
  peak,
  rms,
  runSynth,
  zeroCrossingHz,
} from "./helpers.ts";

const SR = 48_000;

function newSynth(
  opts: { sampleRate?: number; sfxVoices?: number } = {}
): Synth {
  return createSynth({
    sampleRate: opts.sampleRate ?? SR,
    ...(opts.sfxVoices === undefined ? {} : { sfxVoices: opts.sfxVoices }),
  });
}

function songSynth(): Synth {
  const { song, instruments } = fixtureSong();
  const s = newSynth();
  s.loadSong(song, instruments);
  return s;
}

function longSfx(sustain: number): Sfx {
  const base = fixtureJson("sfx-coin.json") as Record<string, unknown>;
  return normalizeSfx({
    ...base,
    envelope: { attack: 0, decay: 0.15, punch: 0, sustain },
  }).value;
}

/** A steady sfx on the custom chip, which has no pitch quantization, volume steps or coloring. */
function customSfx(wave: "square" | "sine", sustain = 0.5): Sfx {
  const r = normalizeSfx({
    category: "custom",
    chip: "custom",
    envelope: { attack: 0, decay: 0.3, punch: 0, sustain },
    // a sine is a frequency modulation sfx without modulation
    ...(wave === "sine"
      ? { fm: { index: 0, indexDecay: 0, ratio: 1 }, wave: "fm" }
      : { duty: { start: 0.5, sweep: 0 }, wave: "square" }),
    frequency: { deltaSlide: 0, min: 0, slide: 0, start: 500 },
    name: wave,
    seed: 1,
    version: 1,
    volume: 0.8,
  });
  if (!r.ok) {
    throw new Error("bad sfx");
  }
  return r.value;
}

function finite(a: Float32Array): boolean {
  for (let i = 0; i < a.length; i += 1) {
    if (!Number.isFinite(a[i])) {
      return false;
    }
  }
  return true;
}

describe("preview mode (no song)", () => {
  it("hosts a custom chip with one channel per kind", () => {
    const s = newSynth();
    const ch = s.channels();
    expect(ch.map((c) => c.kind).sort()).toEqual(
      ["fm", "noise", "pulse", "sample", "sid", "triangle", "wave"].sort()
    );
    expect(new Set(ch.map((c) => c.id)).size).toBe(ch.length);
    expect(s.position()).toBeNull();
    expect(s.playing).toBe(false);
  });

  it("is silent until something plays", () => {
    const out = runSynth(newSynth(), 4800);
    expect(peak([out.left, out.right])).toBe(0);
  });

  it("noteOn plays an instrument that was loaded with setInstrument, noteOff releases it", () => {
    const s = newSynth();
    const inst = fixtureInstruments().lead as Instrument;
    s.setInstrument("lead", inst);
    const idx = s.channels().findIndex((c) => c.kind === "pulse");
    s.noteOn(idx, 69, 1, "lead");
    const held = runSynth(s, 9600);
    expect(rms(held.left, 2400, 9600)).toBeGreaterThan(0.005);
    expect(held.events.some((e) => e.type === "noteOn" && e.note === 69)).toBe(
      true
    );
    s.noteOff(idx);
    const tail = runSynth(s, 24_000);
    expect(rms(tail.left, 20_000, 24_000)).toBeLessThan(1e-4);
    expect(tail.events.some((e) => e.type === "noteOff")).toBe(true);
  });

  it("ignores noteOn for unknown channels and instruments", () => {
    const s = newSynth();
    s.noteOn(99, 60, 1, "nope");
    s.noteOn(-1, 60, 1, "nope");
    s.noteOn(0, 60, 1, "nope");
    s.noteOff(99);
    expect(peak([runSynth(s, 2400).left])).toBe(0);
  });
});

describe("transport", () => {
  it("play starts the song, position follows it, stop and pause hold it", () => {
    const s = songSynth();
    expect(s.playing).toBe(false);
    expect(s.position()).not.toBeNull();
    s.play();
    const a = runSynth(s, 12_000);
    expect(peak([a.left])).toBeGreaterThan(0.01);
    // 96 pulses a beat: a frame is tempo * 96 / (60 * sampleRate) pulses
    const pulses = (frames: number) =>
      (frames * fixtureSong().song.tempo * 96) / (60 * SR);
    expect(s.position()?.pulse).toBeCloseTo(pulses(12_000), 1);
    s.pause();
    runSynth(s, 4800);
    expect(s.position()?.pulse).toBeCloseTo(pulses(12_000), 1);
    s.play();
    runSynth(s, 4800);
    expect(s.position()?.pulse).toBeCloseTo(pulses(16_800), 1);
  });

  it("stop releases the voices and the audio decays to silence", () => {
    const s = songSynth();
    s.play();
    runSynth(s, 12_000);
    s.stop();
    const tail = runSynth(s, 48_000);
    expect(rms(tail.left, 40_000, 48_000)).toBeLessThan(1e-4);
  });

  it("play with an order and row jumps there", () => {
    const s = songSynth();
    s.play({ order: 1, row: 0 });
    const out = runSynth(s, 2400);
    const row = out.events.find((e) => e.type === "row");
    expect(row).toMatchObject({ order: 1, row: 0 });
  });

  it("seek moves the position and keeps the transport state", () => {
    const s = songSynth();
    s.seek(1, 8);
    expect(s.playing).toBe(false);
    s.play();
    const out = runSynth(s, 1200);
    expect(out.events.find((e) => e.type === "row")).toMatchObject({
      order: 1,
      row: 8,
    });
    // while playing, a seek keeps it playing from the new position
    s.seek(0, 4);
    expect(s.playing).toBe(true);
    const after = runSynth(s, 1200);
    expect(after.events.find((e) => e.type === "row")).toMatchObject({
      order: 0,
      row: 4,
    });
  });

  it("loop false plays once and emits an end event, loop true emits loop events", () => {
    const once = songSynth();
    once.play({ loop: false });
    const a = runSynth(once, SR * 40);
    expect(a.events.some((e) => e.type === "end")).toBe(true);
    expect(a.events.some((e) => e.type === "loop")).toBe(false);
    const looping = songSynth();
    looping.play({ loop: true });
    const b = runSynth(looping, SR * 40);
    expect(b.events.some((e) => e.type === "loop")).toBe(true);
    expect(b.events.some((e) => e.type === "end")).toBe(false);
  });

  it("setTempo sets the time between rows: the fixture song at 150 BPM has 4800 frames a row, at 300 BPM 2400", () => {
    const rowFrames = (tempo: number | null, frames = 24_000): number[] => {
      const s = songSynth();
      if (tempo !== null) {
        s.setTempo(tempo);
      }
      s.play();
      return runSynth(s, frames)
        .events.filter((e) => e.type === "row")
        .map((e) => e.frame);
    };
    // a row is 60 * sampleRate / (tempo * rowsPerBeat) frames
    expect(rowFrames(null)).toEqual([0, 4800, 9600, 14_400, 19_200]);
    // a tempo is held within 20..400 BPM: 1800 frames a row at the top, 36000 at the bottom
    expect(rowFrames(1000).slice(0, 3)).toEqual([0, 1800, 3600]);
    expect(rowFrames(5, 40_000)).toEqual([0, 36_000]);
    expect(rowFrames(300)).toEqual([
      0, 2400, 4800, 7200, 9600, 12_000, 14_400, 16_800, 19_200, 21_600,
    ]);
  });

  it("unloadSong goes back to preview mode", () => {
    const s = songSynth();
    s.play();
    runSynth(s, 4800);
    s.unloadSong();
    expect(s.position()).toBeNull();
    const tail = runSynth(s, 24_000);
    expect(rms(tail.left, 20_000, 24_000)).toBeLessThan(1e-4);
  });

  it("the frame counter runs on and never resets", () => {
    const s = songSynth();
    runSynth(s, 1280);
    expect(s.frame).toBe(1280);
    s.play();
    runSynth(s, 640);
    expect(s.frame).toBe(1920);
    s.stop();
    expect(s.frame).toBe(1920);
  });

  it("every channel of the loaded song is listed", () => {
    const { song } = fixtureSong();
    expect(
      songSynth()
        .channels()
        .map((c) => c.id)
    ).toEqual(song.channels.map((c) => c.id));
  });
});

describe("sfx voices", () => {
  it("trigger returns increasing handles and 0 for an unknown id", () => {
    const s = newSynth();
    s.loadSfx("coin", fixtureSfx());
    expect(s.trigger("nope")).toBe(0);
    const a = s.trigger("coin");
    const b = s.trigger("coin");
    expect(a).toBeGreaterThanOrEqual(1);
    expect(b).toBeGreaterThan(a);
  });

  it("a triggered sfx makes sound and emits a trigger event", () => {
    const s = newSynth();
    s.loadSfx("coin", fixtureSfx());
    s.trigger("coin");
    const out = runSynth(s, 12_000);
    expect(peak([out.left, out.right])).toBeGreaterThan(0.02);
    expect(out.events.filter((e) => e.type === "trigger")).toHaveLength(1);
    expect(out.events[0]).toMatchObject({ id: "coin", type: "trigger" });
  });

  it("unloadSfx forgets the id", () => {
    const s = newSynth();
    s.loadSfx("coin", fixtureSfx());
    s.unloadSfx("coin");
    expect(s.trigger("coin")).toBe(0);
  });

  it("velocity scales the level linearly", () => {
    const level = (velocity: number): number => {
      const s = newSynth();
      s.loadSfx("sq", customSfx("square"));
      s.trigger("sq", { velocity });
      const o = runSynth(s, 9600);
      return peak([o.left, o.right]);
    };
    expect(level(0.25) / level(1)).toBeCloseTo(0.25, 2);
    expect(level(0.5) / level(1)).toBeCloseTo(0.5, 2);
    // out of range velocities are clamped to 0..1
    expect(level(3)).toBeCloseTo(level(1), 6);
    expect(level(-1)).toBe(0);
  });

  describe("pan", () => {
    const sides = (sfx: Sfx, pan: number) => {
      const s = newSynth();
      s.loadSfx("fx", sfx);
      s.trigger("fx", { pan });
      const o = runSynth(s, 9600);
      return { l: rms(o.left), r: rms(o.right) };
    };

    it("is an equal power pan on a chip with free panning", () => {
      const sq = customSfx("square");
      const left = sides(sq, -1);
      const centre = sides(sq, 0);
      const half = sides(sq, -0.5);
      const right = sides(sq, 1);
      // hard left and right keep only their own side
      expect(left.r).toBeLessThan(left.l * 0.001);
      expect(right.l).toBeLessThan(right.r * 0.001);
      // the centre is 1 / sqrt(2) of a hard pan on each side
      expect(centre.l).toBeCloseTo(centre.r, 5);
      expect(centre.l / left.l).toBeCloseTo(Math.SQRT1_2, 2);
      // L = cos((pan + 1) pi / 4), R = sin((pan + 1) pi / 4): 2.414 at -0.5
      expect(half.l / half.r).toBeCloseTo(1 / Math.tan(Math.PI / 8), 1);
    });

    it.each([
      ["nes", fixtureSfx()],
      ["c64", fixtureDemo("c64").sfx],
      ["adlib", fixtureDemo("adlib").sfx],
    ])("is ignored on %s, which mixes mono to both sides", (_, sfx) => {
      const hard = sides(sfx, -1);
      expect(hard.l).toBeGreaterThan(0.01);
      expect(hard.r).toBeCloseTo(hard.l, 5);
    });

    it.each([
      ["genesis", fixtureDemo("genesis").sfx],
      ["gameboy", fixtureDemo("gameboy").sfx],
    ])("snaps to left, centre or right on %s", (_, sfx) => {
      const left = sides(sfx, -1);
      const right = sides(sfx, 1);
      const near = sides(sfx, 0.3);
      expect(left.l).toBeGreaterThan(0.01);
      expect(left.r).toBeLessThan(left.l * 0.001);
      expect(right.r).toBeGreaterThan(0.01);
      expect(right.l).toBeLessThan(right.r * 0.001);
      // a pan that is not near either side is the centre
      expect(near.l).toBeCloseTo(near.r, 5);
    });
  });

  it("pitch is a semitone offset to the start frequency", () => {
    const hz = (pitch: number | undefined) => {
      const s = newSynth();
      s.loadSfx("sq", customSfx("square"));
      s.trigger("sq", pitch === undefined ? {} : { pitch });
      const o = runSynth(s, 24_000);
      return zeroCrossingHz(o.left.subarray(2400, 24_000), SR);
    };
    expect(hz(undefined)).toBeCloseTo(500, 0);
    expect(hz(12)).toBeCloseTo(1000, 0);
    expect(hz(-12)).toBeCloseTo(250, 0);
    expect(hz(7)).toBeCloseTo(500 * 2 ** (7 / 12), 0);
  });

  it("the same seed gives the same sound, a different seed a different noise sound", () => {
    const noisy = normalizeSfx({
      ...(fixtureJson("sfx-coin.json") as Record<string, unknown>),
      wave: "noise",
    }).value;
    const run = (seed: number) => {
      const s = newSynth();
      s.loadSfx("n", noisy);
      s.trigger("n", { seed });
      return hashChannels([runSynth(s, 4800).left]);
    };
    expect(run(5)).toBe(run(5));
    expect(run(5)).not.toBe(run(6));
  });

  it("release ends a sustained sfx early", () => {
    const sfx = longSfx(1.5);
    const tailRms = (releaseAt: number | null): number => {
      const s = newSynth();
      s.loadSfx("hold", sfx);
      const h = s.trigger("hold");
      if (releaseAt === null) {
        return rms(runSynth(s, SR).left, 24_000, SR);
      }
      runSynth(s, releaseAt);
      s.release(h);
      const out = runSynth(s, SR - releaseAt);
      return rms(out.left, 24_000 - releaseAt, SR - releaseAt);
    };
    expect(tailRms(null)).toBeGreaterThan(0.01);
    expect(tailRms(4800)).toBeLessThan(0.002);
  });

  it("release with a zero, unknown or stale handle leaves the sounding sfx alone", () => {
    const sfx = longSfx(1.5);
    // one voice: the second trigger steals the voice the first one had
    const tailRms = (stale: boolean) => {
      const s = newSynth({ sfxVoices: 1 });
      s.loadSfx("hold", sfx);
      const first = s.trigger("hold");
      runSynth(s, 4800);
      s.trigger("hold");
      if (stale) {
        s.release(0);
        s.release(12_345);
        s.release(first);
      }
      return rms(runSynth(s, 12_000).left, 4800, 12_000);
    };
    const untouched = tailRms(false);
    expect(untouched).toBeGreaterThan(0.02);
    // the stolen sound's handle is not the new sound's handle
    expect(tailRms(true)).toBe(untouched);
  });

  it("releasing the handle of a sounding sfx ends it", () => {
    const s = newSynth({ sfxVoices: 1 });
    s.loadSfx("hold", longSfx(1.5));
    s.trigger("hold");
    runSynth(s, SR);
    const second = s.trigger("hold");
    s.release(second);
    expect(rms(runSynth(s, 12_000).left, 4800, 12_000)).toBeLessThan(0.002);
  });

  it("voice stealing: with fewer voices than triggers, only that many sounds play at once", () => {
    // steady in-phase sines, so n sounding voices add up to n times the level. The limiter is off
    const level = (voices: number): number => {
      const s = newSynth({ sfxVoices: voices });
      s.setMaster({ limiter: false });
      s.loadSfx("sine", customSfx("sine", 1));
      for (let i = 0; i < 6; i += 1) {
        s.trigger("sine");
        runSynth(s, 4800);
      }
      return rms(runSynth(s, 4800).left);
    };
    const one = level(1);
    expect(one).toBeGreaterThan(0.1);
    expect(level(2) / one).toBeCloseTo(2, 1);
    expect(level(6) / one).toBeCloseTo(6, 1);
  });

  it("handles stay unique when voices are stolen, and releasing a stolen handle is harmless", () => {
    const s = newSynth({ sfxVoices: 2 });
    s.loadSfx("hold", longSfx(1));
    const handles: number[] = [];
    const left = new Float32Array(48_000);
    for (let i = 0; i < 6; i += 1) {
      handles.push(s.trigger("hold", { seed: i + 1 }));
      left.set(runSynth(s, 4800).left, i * 4800);
    }
    expect(handles.every((h) => h > 0)).toBe(true);
    expect(new Set(handles).size).toBe(6);
    expect(finite(left)).toBe(true);
    expect(rms(left, 24_000, 28_800)).toBeGreaterThan(0.01);
    s.release(handles[0] ?? 0);
    const after = runSynth(s, 4800);
    expect(finite(after.left)).toBe(true);
    expect(rms(after.left)).toBeGreaterThan(0.01);
  });

  it("a stolen voice fades out instead of jumping to the new sound", () => {
    const maxStep = (a: Float32Array): number => {
      let worst = 0;
      for (let i = 1; i < a.length; i += 1) {
        worst = Math.max(worst, Math.abs((a[i] ?? 0) - (a[i - 1] ?? 0)));
      }
      return worst;
    };
    const s = newSynth({ sfxVoices: 1 });
    s.loadSfx("sine", customSfx("sine", 1));
    s.trigger("sine");
    // 500 Hz has a 96 frame period: stop a quarter period past a zero, at the wave's crest
    const before = runSynth(s, 9600 + 24).left;
    s.trigger("sine", { pitch: 7 });
    const after = runSynth(s, 4800).left;
    const crest = Math.abs(before.at(-1) ?? 0);
    expect(crest).toBeGreaterThan(0.15);
    // an abrupt cut would step by the whole crest. The 2 ms fade steps by a small part of it
    // (a 500 Hz sine at this level moves by under 0.02 per frame by itself)
    expect(maxStep(after)).toBeLessThan(0.03);
    // and the old sound is really gone: only the new, higher sound is left afterwards
    const hz = zeroCrossingHz(after.subarray(1200, 4800), SR);
    expect(hz).toBeCloseTo(500 * 2 ** (7 / 12), -1);
  });
});

describe("channels and master", () => {
  /** The scope stem peak and a copy of the last 4096 frames of each channel, after playing the song 0.5 s. */
  const stems = (setup: (s: Synth) => void) => {
    const s = songSynth();
    setup(s);
    s.play();
    const o = runSynth(s, 24_000);
    const reader = createScopeReader(s.scopes, SR);
    const channels = s.channels().map((_, c) => reader.latest(c, 4096).slice());
    return { channels, master: [o.left, o.right] };
  };
  const same = (a: Float32Array | undefined, b: Float32Array | undefined) =>
    Array.from(a ?? []).join() === Array.from(b ?? []).join();

  it("muting a channel silences its stem and leaves the other channels unchanged", () => {
    const base = stems(() => undefined);
    const muted = stems((s) => s.setChannel(0, { muted: true }));
    expect(peak([base.channels[0] ?? new Float32Array()])).toBeGreaterThan(
      0.05
    );
    expect(peak([muted.channels[0] ?? new Float32Array()])).toBe(0);
    for (const c of [1, 2, 3]) {
      expect(same(muted.channels[c], base.channels[c])).toBe(true);
    }
    // the channel is gone from the mix too
    expect(peak(muted.master)).toBeLessThan(peak(base.master));
  });

  it("muting every channel silences the song, and unmuting brings it back", () => {
    const none = stems((s) => {
      for (let c = 0; c < s.channels().length; c += 1) {
        s.setChannel(c, { muted: true });
      }
    });
    expect(peak(none.master)).toBe(0);
    const back = stems((s) => {
      s.setChannel(0, { muted: true });
      s.setChannel(0, { muted: false });
    });
    expect(same(back.channels[0], stems(() => undefined).channels[0])).toBe(
      true
    );
  });

  it("solo keeps only the soloed channel, and clearing the solo restores the others", () => {
    const base = stems(() => undefined);
    const solo = stems((s) => s.setChannel(2, { solo: true }));
    expect(peak([solo.channels[2] ?? new Float32Array()])).toBeGreaterThan(
      0.05
    );
    expect(same(solo.channels[2], base.channels[2])).toBe(true);
    for (const c of [0, 1, 3]) {
      expect(peak([solo.channels[c] ?? new Float32Array()])).toBe(0);
    }
    const cleared = stems((s) => {
      s.setChannel(2, { solo: true });
      s.setChannel(2, { solo: false });
    });
    for (const c of [0, 1, 2, 3]) {
      expect(same(cleared.channels[c], base.channels[c])).toBe(true);
    }
  });

  it("channel volume scales the channel and pan places it", () => {
    const run = (opts: { volume?: number; pan?: number }) => {
      const d = fixtureDemo("snes");
      const s = newSynth();
      s.loadSong(d.song, d.instruments);
      for (let c = 0; c < s.channels().length; c += 1) {
        s.setChannel(c, opts);
      }
      s.play();
      const o = runSynth(s, 24_000);
      return { l: rms(o.left), r: rms(o.right) };
    };
    const full = run({ volume: 1 });
    expect(run({ volume: 0.25 }).l / full.l).toBeCloseTo(0.25, 1);
    expect(run({ volume: 0 }).l).toBe(0);
    const hardLeft = run({ pan: -1 });
    expect(hardLeft.l).toBeGreaterThan(0.01);
    expect(hardLeft.r).toBeLessThan(hardLeft.l * 0.01);
    const hardRight = run({ pan: 1 });
    expect(hardRight.l).toBeLessThan(hardRight.r * 0.01);
  });

  it("master volume scales the output linearly and 0 silences it", () => {
    const run = (volume: number) => {
      const s = songSynth();
      s.setMaster({ volume });
      s.play();
      return rms(runSynth(s, 24_000).left);
    };
    expect(run(0)).toBe(0);
    expect(run(0.5) / run(1)).toBeCloseTo(0.5, 2);
    expect(run(0.25) / run(1)).toBeCloseTo(0.25, 2);
    // the master is held within 0..2
    expect(run(5)).toBe(run(2));
    expect(run(-1)).toBe(0);
  });

  it("the limiter holds loud input at the ceiling, and off it lets the input through", () => {
    const loud = (limiter: boolean) => {
      const s = newSynth();
      s.setMaster({ limiter, volume: 2 });
      s.loadSfx("hold", longSfx(0.5));
      for (let i = 0; i < 8; i += 1) {
        s.trigger("hold", { seed: i });
      }
      const o = runSynth(s, 12_000);
      return peak([o.left, o.right]);
    };
    const ceiling = 10 ** (-0.3 / 20);
    const on = loud(true);
    expect(on).toBeLessThanOrEqual(ceiling + 1e-4);
    // the limiter works the signal down to the ceiling, not far below it
    expect(on).toBeGreaterThan(ceiling - 0.1);
    expect(loud(false)).toBeGreaterThan(1.2);
  });
});

describe("live instrument edit", () => {
  it("setInstrument changes a note that is already playing", () => {
    const inst = fixtureInstruments().lead as Instrument;
    const run = (edit: boolean) => {
      const s = newSynth();
      s.setInstrument("lead", inst);
      const idx = s.channels().findIndex((c) => c.kind === "pulse");
      s.noteOn(idx, 60, 1, "lead");
      const a = runSynth(s, 4800);
      if (edit) {
        const quiet = normalizeInstrument({ ...inst, volume: 0.1 }).value;
        s.setInstrument("lead", quiet);
      }
      const b = runSynth(s, 9600);
      return { a: hashChannels([a.left]), rmsB: rms(b.left, 4800, 9600) };
    };
    const plain = run(false);
    const edited = run(true);
    expect(edited.a).toBe(plain.a);
    expect(edited.rmsB).toBeLessThan(plain.rmsB);
  });

  it("setInstrument for a new id makes it playable by song events on the next note", () => {
    const { song, instruments } = fixtureSong();
    const s = newSynth();
    s.loadSong(song, instruments);
    s.setInstrument("extra", instruments.lead as Instrument);
    s.noteOn(0, 64, 1, "extra");
    expect(peak([runSynth(s, 4800).left])).toBeGreaterThan(0.01);
  });
});

describe("events", () => {
  it("noteOn and noteOff events follow the fixture song's patterns", () => {
    const s = songSynth();
    s.play();
    const out = runSynth(s, SR * 3);
    // a row is 4800 frames. The intro has pulse1 C-5 at row 0, E-5 at row 4, G-5 at row 8, OFF at row 14,
    // and triangle C-2 at row 0 and G-1 at row 16
    const hzOf = (note: number) => 440 * 2 ** ((note - 69) / 12);
    const notes = (channelId: string, type: "noteOff" | "noteOn") =>
      out.events
        .filter((e) => e.type === type && e.channelId === channelId)
        .map((e) => [e.frame, e.note]);
    expect(notes("pulse1", "noteOn")).toEqual([
      [0, 72],
      [19_200, 76],
      [38_400, 79],
    ]);
    expect(notes("pulse1", "noteOff")).toEqual([[67_200, 79]]);
    expect(notes("triangle", "noteOn")).toEqual([
      [0, 36],
      [76_800, 31],
    ]);
    const first = out.events.find(
      (e) => e.type === "noteOn" && e.channelId === "pulse1"
    );
    expect(first).toMatchObject({ channel: 0, id: "lead", velocity: 1 });
    expect(first?.hz).toBeCloseTo(hzOf(72), 6);
    // the song's own channel index is the index in channels()
    expect(
      out.events.find((e) => e.type === "noteOn" && e.channelId === "triangle")
        ?.channel
    ).toBe(2);
    const frames = out.events.map((e) => e.frame);
    expect([...frames].sort((a, b) => a - b)).toEqual(frames);
  });

  it("row events start at row 0 of order 0 on a fresh play", () => {
    const s = songSynth();
    s.play();
    const out = runSynth(s, 1200);
    expect(out.events[0]).toMatchObject({
      frame: 0,
      order: 0,
      row: 0,
      type: "row",
    });
  });
});

describe("scopes", () => {
  it("the master ring holds the output that was rendered, and a muted channel's ring stays silent", () => {
    const s = songSynth();
    s.setChannel(1, { muted: true });
    s.play();
    const out = runSynth(s, 12_000);
    const reader = createScopeReader(s.scopes, SR);
    const master = reader.latest(-1, 1024);
    expect(Array.from(master)).toEqual(
      Array.from(out.left.subarray(12_000 - 1024))
    );
    expect(peak([reader.latest(0, 4096).slice()])).toBeGreaterThan(0.05);
    expect(peak([reader.latest(1, 4096).slice()])).toBe(0);
  });

  it("latest equals at(head - frames): at takes the start of the window", () => {
    const s = songSynth();
    s.play();
    runSynth(s, 8000);
    const reader = createScopeReader(s.scopes, SR);
    const head = s.scopes.head[0] ?? 0;
    const a = reader.latest(-1, 256).slice();
    const b = reader.at(-1, head - 256, 256).slice();
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("at(channel, frame, frames) copies the frames that start at frame, wrapping around the ring", () => {
    const rings = createScopeRings(64, null);
    const [ring] = rings.channels;
    for (let i = 0; i < 64; i += 1) {
      if (ring) {
        ring[i] = i;
      }
    }
    rings.head[0] = 20;
    const reader = createScopeReader(rings, SR);
    expect(Array.from(reader.at(0, 10, 5))).toEqual([10, 11, 12, 13, 14]);
    // absolute frame f lives at ring index f modulo the ring size
    expect(Array.from(reader.at(0, 62, 4))).toEqual([62, 63, 0, 1]);
    expect(Array.from(reader.at(0, 64 + 7, 3))).toEqual([7, 8, 9]);
    expect(Array.from(reader.at(0, -2, 3))).toEqual([62, 63, 0]);
    // the newest frames end at the head
    expect(Array.from(reader.latest(0, 4))).toEqual([16, 17, 18, 19]);
  });

  it("an unknown channel reads as silence", () => {
    const s = songSynth();
    s.play();
    runSynth(s, 4800);
    const reader = createScopeReader(s.scopes, SR);
    expect(peak([reader.latest(99, 128).slice()])).toBe(0);
  });

  it("a shared buffer carries the head and the rings", () => {
    const s = songSynth();
    const sab = new SharedArrayBuffer(scopeBufferBytes(s.scopes.frames));
    s.setScopeBuffer(sab);
    s.play();
    const out = runSynth(s, 12_000);
    const head = new Uint32Array(sab, 0, 1);
    expect(head[0]).toBe(12_000 % s.scopes.frames);
    const master = new Float32Array(
      sab,
      4 + 10 * s.scopes.frames * 4,
      s.scopes.frames
    );
    // the master ring is the last ring: the same frames the host got back
    const end = head[0] ?? 0;
    expect(Array.from(master.subarray(end - 256, end))).toEqual(
      Array.from(out.left.subarray(12_000 - 256))
    );
  });
});

describe("sample rates", () => {
  for (const rate of [22_050, 32_000, 44_100, 96_000]) {
    it(`renders finite audio at ${rate} Hz with the same musical timing`, () => {
      const { song, instruments } = fixtureSong();
      const s = newSynth({ sampleRate: rate });
      s.loadSong(song, instruments);
      s.loadSfx("coin", fixtureSfx());
      s.play();
      s.trigger("coin");
      const out = runSynth(s, rate * 2);
      expect(finite(out.left)).toBe(true);
      expect(peak([out.left, out.right])).toBeGreaterThan(0.05);
      expect(peak([out.left, out.right])).toBeLessThan(1);
      const [, row] = out.events.filter((e) => e.type === "row");
      // a row at tempo 150 and 4 rows per beat is 0.1 s
      expect((row?.frame ?? 0) / rate).toBeCloseTo(0.1, 2);
    });
  }
});

describe("every chip survives a stress run", () => {
  for (const chip of [
    "gameboy",
    "c64",
    "genesis",
    "adlib",
    "snes",
    "custom",
  ] as const) {
    it(chip, () => {
      const d = fixtureDemo(chip);
      const s = newSynth();
      s.loadSong(d.song, d.instruments);
      s.loadSfx("fx", d.sfx);
      s.play();
      const left = new Float32Array(SR * 3);
      const right = new Float32Array(SR * 3);
      for (let i = 0; i < 6; i += 1) {
        s.trigger("fx", { pan: (i - 2.5) / 3, seed: i });
        const part = runSynth(s, SR / 2);
        left.set(part.left, (i * SR) / 2);
        right.set(part.right, (i * SR) / 2);
      }
      expect(finite(left) && finite(right)).toBe(true);
      expect(peak([left, right])).toBeLessThan(1);
      expect(peak([left, right])).toBeGreaterThan(0.05);
    });
  }
});
