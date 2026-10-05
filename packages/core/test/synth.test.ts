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
    expect(ch.length).toBeGreaterThan(3);
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
    const p1 = s.position();
    expect(p1?.pulse).toBeGreaterThan(0);
    s.pause();
    runSynth(s, 4800);
    const p2 = s.position();
    expect(p2?.pulse).toBeCloseTo(p1?.pulse ?? 0, 0);
    s.play();
    runSynth(s, 4800);
    expect(s.position()?.pulse).toBeGreaterThan(p2?.pulse ?? 0);
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

  it("setTempo scales the time between rows", () => {
    const rowFrames = (tempo: number | null): number[] => {
      const s = songSynth();
      if (tempo !== null) {
        s.setTempo(tempo);
      }
      s.play();
      return runSynth(s, SR * 2)
        .events.filter((e) => e.type === "row")
        .map((e) => e.frame);
    };
    const normal = rowFrames(null);
    const fast = rowFrames(300);
    expect(fast.length).toBeGreaterThan(normal.length);
    expect((fast[1] ?? 0) - (fast[0] ?? 0)).toBeLessThan(
      (normal[1] ?? 0) - (normal[0] ?? 0)
    );
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

  it("velocity scales the level, pan moves the image", () => {
    const level = (velocity: number): number => {
      const s = newSynth();
      s.loadSfx("coin", fixtureSfx());
      s.trigger("coin", { velocity });
      const o = runSynth(s, 9600);
      return peak([o.left, o.right]);
    };
    expect(level(0.25)).toBeLessThan(level(1) * 0.6);
    const side = (pan: number) => {
      // pan is free on snes and custom only: nes and gameboy-style chips mix to mono
      const s = newSynth();
      s.loadSong(fixtureDemo("snes").song, fixtureDemo("snes").instruments);
      s.loadSfx("coin", fixtureDemo("snes").sfx);
      s.trigger("coin", { pan });
      const o = runSynth(s, 9600);
      return { l: rms(o.left), r: rms(o.right) };
    };
    const left = side(-1);
    const right = side(1);
    expect(left.l).toBeGreaterThan(left.r * 2);
    expect(right.r).toBeGreaterThan(right.l * 2);
  });

  it("pitch shifts the sfx", () => {
    const s = newSynth();
    s.loadSfx("coin", fixtureSfx());
    const base = (() => {
      s.trigger("coin");
      return runSynth(s, 4800);
    })();
    const up = (() => {
      const t = newSynth();
      t.loadSfx("coin", fixtureSfx());
      t.trigger("coin", { pitch: 12 });
      return runSynth(t, 4800);
    })();
    expect(hashChannels([base.left])).not.toBe(hashChannels([up.left]));
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

  it("release with a stale or zero handle does nothing", () => {
    const s = newSynth();
    s.loadSfx("coin", fixtureSfx());
    s.release(0);
    s.release(12_345);
    const h = s.trigger("coin");
    runSynth(s, 48_000);
    s.release(h);
    expect(peak([runSynth(s, 480).left])).toBeLessThan(1e-3);
  });

  it("voice stealing: more triggers than voices still sound, with no NaN and no clip", () => {
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
    expect(peak([left])).toBeLessThan(1);
    expect(rms(left, 24_000, 28_800)).toBeGreaterThan(0.01);
    // releasing a handle that was stolen is harmless
    s.release(handles[0] ?? 0);
    const after = runSynth(s, 4800);
    expect(finite(after.left)).toBe(true);
  });

  it("a stolen voice fades instead of clicking", () => {
    const s = newSynth({ sfxVoices: 1 });
    s.loadSfx("hold", longSfx(2));
    s.trigger("hold");
    runSynth(s, 9600);
    s.trigger("hold", { pitch: 7 });
    const out = runSynth(s, 4800);
    let worst = 0;
    for (let i = 1; i < out.left.length; i += 1) {
      worst = Math.max(
        worst,
        Math.abs((out.left[i] ?? 0) - (out.left[i - 1] ?? 0))
      );
    }
    expect(worst).toBeLessThan(0.35);
  });

  it("eight sfx at once stay under the limiter ceiling", () => {
    const s = newSynth();
    s.loadSfx("hold", longSfx(0.5));
    for (let i = 0; i < 8; i += 1) {
      s.trigger("hold", { seed: i });
    }
    const out = runSynth(s, 24_000);
    expect(peak([out.left, out.right])).toBeLessThanOrEqual(
      10 ** (-0.3 / 20) + 1e-4
    );
  });
});

describe("channels and master", () => {
  it("muting every channel silences the song, muting one changes the mix", () => {
    const frames = 24_000;
    const mix = (setup: (s: Synth) => void): { h: string; p: number } => {
      const s = songSynth();
      setup(s);
      s.play();
      const o = runSynth(s, frames);
      return { h: hashChannels([o.left, o.right]), p: peak([o.left, o.right]) };
    };
    const base = mix(() => undefined);
    const noPulse = mix((s) => s.setChannel(0, { muted: true }));
    const none = mix((s) => {
      for (let c = 0; c < s.channels().length; c += 1) {
        s.setChannel(c, { muted: true });
      }
    });
    expect(noPulse.h).not.toBe(base.h);
    expect(none.p).toBeLessThan(1e-4);
    expect(base.p).toBeGreaterThan(0.05);
  });

  it("solo keeps only the soloed channel", () => {
    const frames = 24_000;
    const run = (setup: (s: Synth) => void) => {
      const s = songSynth();
      setup(s);
      s.play();
      const o = runSynth(s, frames);
      return hashChannels([o.left, o.right]);
    };
    const soloed = run((s) => s.setChannel(2, { solo: true }));
    const mutedOthers = run((s) => {
      for (let c = 0; c < s.channels().length; c += 1) {
        s.setChannel(c, { muted: c !== 2 });
      }
    });
    expect(soloed).toBe(mutedOthers);
    const unsoloed = run((s) => {
      s.setChannel(2, { solo: true });
      s.setChannel(2, { solo: false });
    });
    const plain = run(() => undefined);
    expect(unsoloed).toBe(plain);
  });

  it("channel volume and pan apply", () => {
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
    const quiet = run({ volume: 0.25 });
    expect(quiet.l).toBeLessThan(full.l * 0.6);
    const hardLeft = run({ pan: -1 });
    expect(hardLeft.l).toBeGreaterThan(hardLeft.r * 3);
  });

  it("master volume scales the output and 0 silences it", () => {
    const run = (volume: number) => {
      const s = songSynth();
      s.setMaster({ volume });
      s.play();
      const o = runSynth(s, 24_000);
      return rms(o.left);
    };
    expect(run(0)).toBeLessThan(1e-6);
    expect(run(0.5)).toBeLessThan(run(1) * 0.75);
  });

  it("the limiter can be turned off, and then loud input is not trimmed to the ceiling", () => {
    const s = newSynth();
    s.setMaster({ limiter: false, volume: 2 });
    s.loadSfx("hold", longSfx(0.5));
    for (let i = 0; i < 8; i += 1) {
      s.trigger("hold", { seed: i });
    }
    const off = runSynth(s, 12_000);
    const t = newSynth();
    t.setMaster({ limiter: true, volume: 2 });
    t.loadSfx("hold", longSfx(0.5));
    for (let i = 0; i < 8; i += 1) {
      t.trigger("hold", { seed: i });
    }
    const on = runSynth(t, 12_000);
    expect(peak([on.left, on.right])).toBeLessThanOrEqual(
      10 ** (-0.3 / 20) + 1e-4
    );
    expect(peak([off.left, off.right])).toBeGreaterThanOrEqual(
      peak([on.left, on.right])
    );
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
  it("noteOn events carry the channel, note, frequency and instrument", () => {
    const s = songSynth();
    s.play();
    const out = runSynth(s, SR * 3);
    const ons = out.events.filter((e) => e.type === "noteOn");
    expect(ons.length).toBeGreaterThan(4);
    for (const e of ons) {
      expect(e.channel).toBeGreaterThanOrEqual(0);
      expect(e.hz).toBeGreaterThan(8);
      expect(e.channelId.length).toBeGreaterThan(0);
      expect(e.velocity).toBeGreaterThan(0);
    }
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
  it("rings fill with the channel stems and the master", () => {
    const s = songSynth();
    s.play();
    runSynth(s, 12_000);
    const reader = createScopeReader(s.scopes, SR);
    const master = reader.latest(-1, 1024);
    expect(master.length).toBe(1024);
    expect(peak([master])).toBeGreaterThan(0.01);
    let any = false;
    for (let c = 0; c < s.channels().length; c += 1) {
      if (peak([reader.latest(c, 512).slice()]) > 0.001) {
        any = true;
      }
    }
    expect(any).toBe(true);
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
    runSynth(s, 12_000);
    const head = new Uint32Array(sab, 0, 1);
    expect(head[0]).toBe(12_000 % s.scopes.frames);
    const master = new Float32Array(
      sab,
      4 + 10 * s.scopes.frames * 4,
      s.scopes.frames
    );
    expect(peak([master.slice()])).toBeGreaterThan(0.01);
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
