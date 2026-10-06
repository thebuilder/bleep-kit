/* Offline rendering (section 4.2) and the per-chip sound checks: signal present, no clipping, no DC, no clicks at
   note boundaries. */

import { describe, expect, it } from "vitest";
import {
  quantizeNoiseRate as genesisFixedRate,
  quantizeTone3NoiseRate as genesisTone3Rate,
} from "../src/chips/genesis.ts";
import { compileSfx } from "../src/engine/sfx-compile.ts";
import type { ChipId, Instrument, RenderResult } from "../src/index.ts";
import {
  CHIP_IDS,
  createSynth,
  normalizeInstrument,
  normalizeSfx,
  normalizeSong,
  renderInstrumentNote,
  renderSfx,
  renderSong,
} from "../src/index.ts";
import { analyze } from "../src/tools.ts";
import type { Demo } from "./helpers.ts";
import {
  bandEnergy,
  fixtureDemo,
  fixtureInstruments,
  fixtureJson,
  fixtureSfx,
  fixtureShortDemo,
  fixtureShortSong,
  peak,
  rms,
  runSynth,
  toDb,
  zeroCrossingHz,
} from "./helpers.ts";

const CHIPS = ["gameboy", "c64", "genesis", "adlib", "snes", "custom"] as const;
const CEILING = 10 ** (-0.3 / 20);

function dc(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i += 1) {
    s += buf[i] ?? 0;
  }
  return s / Math.max(1, buf.length);
}

function allFinite(r: RenderResult): boolean {
  for (const ch of r.channels) {
    for (let i = 0; i < ch.length; i += 1) {
      if (!Number.isFinite(ch[i])) {
        return false;
      }
    }
  }
  return true;
}

/** The default render of each chip's short song, made once for the tests that only read it. */
const shortRenders = new Map<string, RenderResult>();
function shortRender(chip: string, d: Demo): RenderResult {
  let r = shortRenders.get(chip);
  if (!r) {
    r = renderSong(d.song, d.instruments);
    shortRenders.set(chip, r);
  }
  return r;
}

describe("renderSong", () => {
  it.each<[string, Demo]>([
    ["nes", fixtureShortSong() as Demo],
    ...CHIPS.map((chip): [string, Demo] => [chip, fixtureShortDemo(chip)]),
  ])(
    "%s song: stereo, audible, finite, under the ceiling, no DC",
    (chip, d) => {
      const r = shortRender(chip, d);
      expect(r.sampleRate).toBe(48_000);
      expect(r.channels).toHaveLength(2);
      expect(r.channels[0]?.length).toBe(r.frames);
      expect(r.channels[1]?.length).toBe(r.frames);
      expect(allFinite(r)).toBe(true);
      const p = peak(r.channels);
      expect(p).toBeGreaterThan(0.1);
      expect(p).toBeLessThanOrEqual(CEILING + 1e-4);
      expect(Math.abs(dc(r.channels[0] as Float32Array))).toBeLessThan(0.006);
      expect(Math.abs(dc(r.channels[1] as Float32Array))).toBeLessThan(0.006);
    }
  );

  it("honours the sample rate", () => {
    const { song, instruments } = fixtureShortSong();
    const a = renderSong(song, instruments, { sampleRate: 48_000, tail: 0.5 });
    const b = renderSong(song, instruments, { sampleRate: 44_100, tail: 0.5 });
    expect(b.sampleRate).toBe(44_100);
    expect(b.frames / 44_100).toBeCloseTo(a.frames / 48_000, 1);
  });

  it("tail extends the render by the requested seconds", () => {
    const { song, instruments } = fixtureShortSong();
    const a = renderSong(song, instruments, { tail: 0.25 });
    const b = renderSong(song, instruments, { tail: 1.25 });
    expect(b.frames - a.frames).toBe(48_000);
  });

  it("loops: the loop section is repeated and loopStart and loopEnd bracket the second pass", () => {
    const { song, instruments } = fixtureShortSong();
    const one = renderSong(song, instruments, { loops: 1, tail: 0 });
    const three = renderSong(song, instruments, { loops: 3, tail: 0 });
    expect(one.loopStart).toBeDefined();
    expect(one.loopEnd).toBeDefined();
    const pass = (one.loopEnd ?? 0) - (one.loopStart ?? 0);
    expect(pass).toBeGreaterThan(0);
    expect(one.loopStart).toBe(three.loopStart);
    expect(three.frames - one.frames).toBeGreaterThanOrEqual(2 * pass - 2);
    expect(three.frames - one.frames).toBeLessThanOrEqual(2 * pass + 2);
    const loopFrames = (r: RenderResult) =>
      r.events.filter((e) => e.type === "loop").map((e) => e.frame);
    // every render plays the loop section at least twice; loops counts the passes after the intro
    expect(loopFrames(one)).toHaveLength(1);
    expect(loopFrames(three)).toHaveLength(3);
    // the loop points bracket the second pass: loopStart is where the first pass ends, loopEnd is one pass later
    expect(loopFrames(one)[0]).toBe(one.loopStart);
    expect(one.frames).toBe(one.loopEnd);
    // fewer than one pass still renders the two minimum
    const zero = renderSong(song, instruments, { loops: 0, tail: 0 });
    expect(zero.loopStart).toBe(one.loopStart);
    expect(zero.loopEnd).toBe(one.loopEnd);
  });

  it("later passes of the loop keep the level of the one before (the passes are not sample identical: noise runs on)", () => {
    const { song, instruments } = fixtureShortSong();
    const r = renderSong(song, instruments, { loops: 3, tail: 0 });
    const ls = r.loopStart ?? 0;
    const le = r.loopEnd ?? 0;
    const pass = le - ls;
    const left = r.channels[0] as Float32Array;
    // the second and third passes are the same music: compare rms of the matching halves
    const a = rms(left, ls + 4800, ls + pass - 4800);
    const b = rms(left, ls + pass + 4800, ls + 2 * pass - 4800);
    expect(Math.abs(a - b) / Math.max(a, 1e-9)).toBeLessThan(0.15);
  });

  it("the loop seam is clean on the title song: the audio before loopEnd matches the audio before loopStart (below -40 dB)", () => {
    const title = fixtureShortSong();
    const { loop } = analyze(shortRender("nes", title as Demo));
    expect(loop).not.toBeNull();
    expect(loop?.seamDiffDb ?? 0).toBeLessThan(-40);
  });

  it.each(CHIPS)(
    "the loop seam is clean on the %s demo (below -40 dB)",
    (chip) => {
      const { loop } = analyze(shortRender(chip, fixtureShortDemo(chip)));
      expect(loop).not.toBeNull();
      expect(loop?.seamDiffDb ?? 0).toBeLessThan(-40);
    }
  );

  it("a looped FM voice with an LFO repeats exactly: every pass puts its notes the same distance from a tick", () => {
    const demo = fixtureDemo("genesis");
    // three bars at 140 bpm last 308.57 ticks of 1/60 s: a tick grid that ran on through the wrap would shift every pass
    const mml =
      "t140 l8 @fmlead o5 [c e g e]2 [f a > c < a]2 L [c e g > c < g e]2 [d f a > d < a f]2";
    const doc = {
      ...demo.song,
      channels: demo.song.channels.map((c) =>
        c.id === "fm1"
          ? { ...c, instrument: "fmlead", mml }
          : { ...c, mml: null }
      ),
      order: [],
      patterns: {},
    };
    const song = normalizeSong(doc, demo.instruments);
    expect(song.ok).toBe(true);
    expect(demo.instruments.fmlead?.fm?.lfo).not.toBeNull();
    const r = renderSong(song.value, demo.instruments);
    const { loop } = analyze(r);
    expect(loop?.seamDiffDb ?? 0).toBeLessThan(-80);
    // and the sample step across the wrap is no bigger than the steps either side of it
    const left = r.channels[0] as Float32Array;
    const ls = r.loopStart ?? 0;
    const le = r.loopEnd ?? 0;
    const across = Math.abs((left[ls] ?? 0) - (left[le - 1] ?? 0));
    let local = 0;
    for (let i = ls - 400; i < ls + 400; i += 1) {
      local = Math.max(local, Math.abs((left[i + 1] ?? 0) - (left[i] ?? 0)));
    }
    expect(across).toBeLessThanOrEqual(local * 1.05 + 1e-4);
  });

  it("an FM note sounds the same whatever the voice played before it", () => {
    const demo = fixtureDemo("genesis");
    const inst = demo.instruments.fmlead as Instrument;
    const after = renderInstrumentNote(inst, 69, {
      chip: "genesis",
      duration: 0.2,
      release: 0.05,
    });
    const again = renderInstrumentNote(inst, 69, {
      chip: "genesis",
      duration: 0.2,
      release: 0.05,
    });
    expect(
      Array.from((after.channels[0] as Float32Array).subarray(0, 4000))
    ).toEqual(
      Array.from((again.channels[0] as Float32Array).subarray(0, 4000))
    );
    // two song notes on one voice, the same note twice: the second starts from the same state as the first
    // 120 bpm: four quarter notes are 120 ticks exactly, so both notes start on a tick
    const mml = "t120 @fmlead o4 c4 r4 r4 r4 c4 r4";
    const song = normalizeSong(
      {
        ...demo.song,
        channels: demo.song.channels.map((c) =>
          c.id === "fm1"
            ? { ...c, instrument: "fmlead", mml }
            : { ...c, mml: null }
        ),
        loop: null,
        order: [],
        patterns: {},
      },
      demo.instruments
    );
    const r = renderSong(song.value, demo.instruments, { tail: 0 });
    const ch = r.channels[0] as Float32Array;
    const noteOns = r.events
      .filter((e) => e.type === "noteOn")
      .map((e) => e.frame);
    expect(noteOns).toHaveLength(2);
    const [a, b] = noteOns as [number, number];
    // the first note also has the limiter's start-up latency, so compare once that is past
    for (let i = 400; i < 2400; i += 1) {
      expect(ch[b + i] ?? 0).toBeCloseTo(ch[a + i] ?? 0, 5);
    }
  });

  it("songs without a loop have no loop points", () => {
    const { song, instruments } = fixtureShortSong();
    const noLoop = { ...song, loop: null };
    const r = renderSong(noLoop, instruments, { tail: 0.1 });
    expect(r.loopStart).toBeUndefined();
    expect(r.loopEnd).toBeUndefined();
  });

  it("stems: one dry mono stem per channel, with the channel ids", () => {
    const { song, instruments } = fixtureShortSong();
    const r = renderSong(song, instruments, { stems: true, tail: 0.1 });
    expect(r.stemIds).toEqual(song.channels.map((c) => c.id));
    expect(r.stems).toHaveLength(song.channels.length);
    for (const st of r.stems ?? []) {
      expect(st.length).toBe(r.frames);
    }
    expect(peak([r.stems?.[0] as Float32Array])).toBeGreaterThan(0.05);
    expect(renderSong(song, instruments, { tail: 0.1 }).stems).toBeUndefined();
  });

  it("events: one row event per row, the end event where the last row ends, nothing past the render", () => {
    const { song, instruments } = fixtureShortSong();
    const r = renderSong({ ...song, loop: null }, instruments, { tail: 0.1 });
    // 16 rows of 4800 frames at 150 BPM, 4 rows a beat
    const rows = r.events.filter((e) => e.type === "row");
    expect(rows).toHaveLength(16);
    expect(rows.map((e) => e.frame)).toEqual(
      Array.from({ length: 16 }, (_, i) => i * 4800)
    );
    expect(r.events.find((e) => e.type === "end")?.frame).toBe(16 * 4800);
    // the tail is 0.1 s after the end
    expect(r.frames).toBe(16 * 4800 + 4800);
    for (const e of r.events) {
      expect(e.frame).toBeLessThan(r.frames);
    }
    const frames = r.events.map((e) => e.frame);
    expect([...frames].sort((a, b) => a - b)).toEqual(frames);
  });

  it("onProgress reports frames against the expected total, and returning false aborts the render", () => {
    const { song, instruments } = fixtureShortSong();
    const calls: [number, number][] = [];
    const aborted = renderSong(song, instruments, {
      onProgress: (frames, total) => {
        calls.push([frames, total]);
        return calls.length < 2 ? undefined : false;
      },
    });
    // the pattern, one more pass of it (the loop goes back to it), and the 1 s tail
    const expected = 16 * 4800 + 16 * 4800 + 48_000;
    expect(calls).toEqual([
      [65_536, expected],
      [131_072, expected],
    ]);
    // it stopped at the second call, short of the second block of progress
    expect(aborted.frames).toBeGreaterThan(65_536);
    expect(aborted.frames).toBeLessThanOrEqual(131_072);
    expect(renderSong(song, instruments).frames).toBe(expected);
  });

  it("an empty song renders silence of the tail length at most", () => {
    const { song, instruments } = fixtureShortSong();
    const empty = {
      ...song,
      channels: song.channels.map((c) => ({ ...c, mml: null })),
      loop: null,
      order: [],
      patterns: {},
    };
    const r = renderSong(empty, instruments, { tail: 0.2 });
    expect(allFinite(r)).toBe(true);
    expect(peak(r.channels)).toBe(0);
    expect(r.frames).toBeLessThan(48_000 * 2);
  });

  it("master volume comes from the song, and the options set only the limiter", () => {
    const { song, instruments } = fixtureShortSong();
    const peakOf = (volume: number, opts: Record<string, unknown> = {}) =>
      peak(
        renderSong(
          { ...song, loop: null, master: { ...song.master, volume } },
          instruments,
          { tail: 0.1, ...opts }
        ).channels
      );
    // below the limiter the render is linear in the master volume
    expect(peakOf(0.25) / peakOf(0.8)).toBeCloseTo(0.25 / 0.8, 3);
    // a loud master is held to the ceiling, and without the limiter it is not. The options' volume is ignored
    expect(peakOf(2)).toBeLessThanOrEqual(CEILING + 1e-4);
    expect(
      peakOf(2, { master: { limiter: false, volume: 0.1 } })
    ).toBeGreaterThan(1.2);
  });
});

describe("renderSfx", () => {
  it("renders the coin: short, audible, trimmed to the end of the sound", () => {
    const r = renderSfx(fixtureSfx());
    expect(allFinite(r)).toBe(true);
    expect(r.frames / r.sampleRate).toBeGreaterThan(0.1);
    expect(r.frames / r.sampleRate).toBeLessThan(0.6);
    expect(peak(r.channels)).toBeGreaterThan(0.1);
    // the last 10 ms is the only quiet part
    const tail = Math.round(0.02 * r.sampleRate);
    expect(rms(r.channels[0] as Float32Array, r.frames - tail)).toBeLessThan(
      0.01
    );
    expect(r.events.some((e) => e.type === "trigger")).toBe(true);
  });

  for (const chip of CHIPS) {
    it(`${chip} sfx is audible and finite`, () => {
      const r = renderSfx(fixtureDemo(chip).sfx);
      expect(allFinite(r)).toBe(true);
      expect(peak(r.channels)).toBeGreaterThan(0.02);
      expect(peak(r.channels)).toBeLessThanOrEqual(CEILING + 1e-4);
      expect(Math.abs(dc(r.channels[0] as Float32Array))).toBeLessThan(0.01);
    });
  }

  it("the render seed picks the noise sequence: the same seed repeats, another seed differs, 1 is the default", () => {
    const noisy = normalizeSfx({
      ...(fixtureJson("sfx-coin.json") as Record<string, unknown>),
      wave: "noise",
    }).value;
    const first = (opts?: { seed: number }) =>
      Array.from(
        (renderSfx(noisy, opts).channels[0] as Float32Array).subarray(0, 4000)
      );
    const one = first({ seed: 1 });
    expect(first({ seed: 1 })).toEqual(one);
    expect(first()).toEqual(one);
    const other = first({ seed: 2 });
    expect(other).not.toEqual(one);
    // a different noise, not the same sound shifted: the two correlate weakly
    let dot = 0;
    let a2 = 0;
    let b2 = 0;
    for (let i = 0; i < one.length; i += 1) {
      dot += (one[i] ?? 0) * (other[i] ?? 0);
      a2 += (one[i] ?? 0) ** 2;
      b2 += (other[i] ?? 0) ** 2;
    }
    expect(Math.abs(dot / Math.sqrt(a2 * b2))).toBeLessThan(0.5);
  });

  function squareSfx(chip: ChipId, volume = 1) {
    const r = normalizeSfx({
      category: "custom",
      chip,
      duty: { start: 0.5, sweep: 0 },
      envelope: { attack: 0, decay: 0.05, punch: 0, sustain: 0.4 },
      frequency: { deltaSlide: 0, min: 0, slide: 0, start: 440 },
      name: "sq",
      seed: 1,
      version: 1,
      volume,
      wave: "square",
    });
    if (!r.ok) {
      throw new Error("bad sfx");
    }
    return r.value;
  }

  it("a full-volume square peaks at -12 dBFS, within 1.5 dB, on every chip", () => {
    for (const chip of CHIP_IDS) {
      const r = renderSfx(squareSfx(chip));
      expect(Math.abs(toDb(peak(r.channels)) + 12), chip).toBeLessThan(1.5);
    }
  });

  it("sfx use the project master: the volume scales the render and the default is 0.8", () => {
    const sfx = squareSfx("nes");
    const base = peak(renderSfx(sfx).channels);
    const same = peak(
      renderSfx(sfx, { master: { limiter: true, volume: 0.8 } }).channels
    );
    const half = peak(
      renderSfx(sfx, { master: { limiter: true, volume: 0.4 } }).channels
    );
    expect(same).toBeCloseTo(base, 5);
    expect(half / base).toBeCloseTo(0.5, 2);
  });

  it("the FM index is in radians: the first sideband follows J1(index) / J0(index)", () => {
    const render = (index: number) => {
      const r = normalizeSfx({
        category: "custom",
        chip: "custom",
        envelope: { attack: 0, decay: 0.05, punch: 0, sustain: 0.6 },
        fm: { index, indexDecay: 0, ratio: 3 },
        frequency: { deltaSlide: 0, min: 0, slide: 0, start: 500 },
        name: "fm",
        seed: 1,
        version: 1,
        volume: 0.8,
        wave: "fm",
      });
      if (!r.ok) {
        throw new Error("bad sfx");
      }
      return renderSfx(r.value).channels[0] as Float32Array;
    };
    // carrier 500 Hz, modulator 1500 Hz: 500 Hz holds J0 and 2000 Hz holds J1 (and no other term lands on either)
    const ratio = (index: number) => {
      const out = render(index);
      const at = (hz: number) =>
        bandEnergy(out, 48_000, hz - 40, hz + 40, 4800, 16_384);
      return at(2000) / at(500);
    };
    // J1(2)^2 / J0(2)^2 = 6.6; a phase swing of 2 cycles (2 pi times the radians) would give about 1
    expect(ratio(2)).toBeGreaterThan(5);
    expect(ratio(2)).toBeLessThan(8.5);
    // J1(1)^2 / J0(1)^2 = 0.33
    expect(ratio(1)).toBeGreaterThan(0.25);
    expect(ratio(1)).toBeLessThan(0.45);
  });

  describe("Genesis noise", () => {
    function noiseSfx(chip: ChipId, slide: number, mode: "long" | "short") {
      const r = normalizeSfx({
        category: "explosion",
        chip,
        envelope: { attack: 0, decay: 0.2, punch: 0, sustain: 0.6 },
        frequency: { deltaSlide: 0, min: 0, slide, start: 300 },
        name: "n",
        noise: { mode },
        seed: 1,
        version: 1,
        volume: 0.8,
        wave: "noise",
      });
      if (!r.ok) {
        throw new Error("bad sfx");
      }
      return r.value;
    }

    it("a noise sfx whose pitch moves clocks the PSG noise from tone 3, a steady one keeps a fixed rate", () => {
      expect(
        compileSfx(noiseSfx("genesis", -2, "long"), 48_000).noiseTone3
      ).toBe(true);
      expect(
        compileSfx(noiseSfx("genesis", 0, "long"), 48_000).noiseTone3
      ).toBe(false);
      expect(compileSfx(noiseSfx("nes", -2, "long"), 48_000).noiseTone3).toBe(
        false
      );
    });

    it("tone 3 mode reaches many rates where the fixed register has three", () => {
      const tone3 = new Set<number>();
      const fixed = new Set<number>();
      for (let i = 0; i < 60; i += 1) {
        const hz = 100 * 8 ** (i / 59);
        const rate = genesisTone3Rate(hz);
        tone3.add(rate);
        fixed.add(genesisFixedRate(hz));
        expect(Math.abs(Math.log(rate / (hz * 16)))).toBeLessThan(0.05);
      }
      expect(fixed.size).toBe(3);
      expect(tone3.size).toBeGreaterThan(30);
    });

    it("renders both modes without gaps or non-finite samples", () => {
      for (const slide of [-2, 0]) {
        const r = renderSfx(noiseSfx("genesis", slide, "long"));
        expect(allFinite(r)).toBe(true);
        expect(peak(r.channels)).toBeGreaterThan(0.05);
      }
    });
  });

  it("a longer tail adds room only up to the end of the sound: the render is trimmed back to silence", () => {
    const frames = (tail: number) => renderSfx(fixtureSfx(), { tail }).frames;
    // the sfx program lasts 14880 frames, the release and echo ring on a little past it
    expect(frames(0)).toBeLessThan(frames(0.25));
    // beyond that the tail changes nothing, so a 2 s tail does not leave 2 s of silence
    expect(frames(1)).toBe(frames(0.25));
    expect(frames(2)).toBe(frames(0.25));
    const long = renderSfx(fixtureSfx(), { tail: 2 });
    // the render ends 10 ms (480 frames) after the last frame above -90 dBFS
    const [l, r] = long.channels as [Float32Array, Float32Array];
    let last = long.frames - 1;
    while (
      last > 0 &&
      Math.abs(l[last] ?? 0) <= 10 ** (-90 / 20) &&
      Math.abs(r[last] ?? 0) <= 10 ** (-90 / 20)
    ) {
      last -= 1;
    }
    expect(long.frames - 1 - last).toBe(480);
  });
});

describe("renderInstrumentNote", () => {
  const left = (r: RenderResult) => r.channels[0] as Float32Array;

  it("holds the note for the duration, then releases it for the release time", () => {
    const inst = fixtureInstruments().lead as Instrument;
    const r = renderInstrumentNote(inst, 69, { duration: 0.3, release: 0.3 });
    // 0.3 s held and 0.3 s of release, as frames
    expect(r.frames).toBe(28_800);
    expect(rms(left(r), 2400, 14_000)).toBeGreaterThan(0.03);
    expect(rms(left(r), 14_600, 16_400)).toBeLessThan(
      rms(left(r), 2400, 14_000) * 0.25
    );
    expect(rms(left(r), r.frames - 2400)).toBeLessThan(1e-4);
    // a short release ends sooner
    expect(
      renderInstrumentNote(inst, 69, { duration: 0.3, release: 0.05 }).frames
    ).toBe(16_800);
  });

  it("the note number sets the pitch: an octave up doubles it", () => {
    const inst = fixtureInstruments().lead as Instrument;
    const hz = (note: number) =>
      zeroCrossingHz(
        left(
          renderInstrumentNote(inst, note, { duration: 0.3, release: 0.1 })
        ).subarray(2400, 13_000),
        48_000
      );
    expect(hz(81) / hz(69)).toBeCloseTo(2, 1);
    expect(hz(57) / hz(69)).toBeCloseTo(0.5, 1);
  });

  it("renders on the chip asked for, and a chip without the instrument's kind falls back to custom", () => {
    const lead = fixtureInstruments().lead as Instrument;
    const render = (inst: Instrument, chip: ChipId) =>
      Array.from(
        left(
          renderInstrumentNote(inst, 57, { chip, duration: 0.2, release: 0.1 })
        ).subarray(0, 6000)
      );
    // a chip colors the sound: the same note on nes and on gameboy differs
    expect(render(lead, "nes")).not.toEqual(render(lead, "gameboy"));
    // the nes has no FM channel: the render is the one on the custom chip, which has every kind
    const fm = normalizeInstrument(
      fixtureJson("instrument-fm-bass.json")
    ).value;
    const asNes = render(fm, "nes");
    expect(asNes).toEqual(render(fm, "custom"));
    expect(Math.max(...asNes.map(Math.abs))).toBeGreaterThan(0.02);
    expect(asNes).not.toEqual(render(fm, "genesis"));
  });

  it("sample instruments play their generator and release to silence", () => {
    const inst = normalizeInstrument(
      fixtureJson("instrument-snes-pluck.json")
    ).value;
    const r = renderInstrumentNote(inst, 60, { duration: 0.4, release: 0.2 });
    expect(allFinite(r)).toBe(true);
    expect(rms(left(r), 1000, 12_000)).toBeGreaterThan(0.01);
    expect(rms(left(r), r.frames - 2400)).toBeLessThan(1e-3);
  });
});

/* A click is a step at a note boundary much larger than anything else nearby. Each channel is soloed through the real
   synth (limiter off, so only the voice and its chip bus shape the signal) and every noteOn and noteOff is inspected. */
describe("no clicks at note boundaries", () => {
  function scan(
    chip: string
  ): { boundaries: number; worst: number; where: string }[] {
    const d = chip === "nes" ? null : fixtureShortDemo(chip, 8);
    const { song, instruments } = d ?? fixtureShortSong();
    const out: { boundaries: number; worst: number; where: string }[] = [];
    for (let c = 0; c < song.channels.length; c += 1) {
      const s = createSynth({ sampleRate: 48_000 });
      s.loadSong(song, instruments);
      const n = s.channels().length;
      for (let k = 0; k < n; k += 1) {
        s.setChannel(k, { muted: k !== c });
      }
      s.setMaster({ limiter: false });
      s.play({ loop: false });
      const { latency } = s as unknown as { latency: number };
      const r = runSynth(s, 48_000 * (chip === "nes" ? 2 : 1.2));
      const m = r.left;
      const pk = peak([m]);
      if (pk < 1e-3) {
        continue;
      }
      let worst = 0;
      let where = "";
      let boundaries = 0;
      for (const e of r.events) {
        if (e.channel !== c || (e.type !== "noteOn" && e.type !== "noteOff")) {
          continue;
        }
        const f = e.frame + latency;
        if (f < 400 || f > m.length - 400) {
          continue;
        }
        boundaries += 1;
        let step = 0;
        for (let i = f - 1; i <= f + 2; i += 1) {
          step = Math.max(step, Math.abs((m[i] ?? 0) - (m[i - 1] ?? 0)));
        }
        let nb = 0;
        for (let i = f - 300; i <= f + 300; i += 1) {
          if (i >= f - 3 && i <= f + 4) {
            continue;
          }
          nb = Math.max(nb, Math.abs((m[i] ?? 0) - (m[i - 1] ?? 0)));
        }
        // ignore steps that are small against the channel's own level
        const ratio = step > 0.08 * pk ? step / Math.max(nb, 0.01 * pk) : 0;
        if (ratio > worst) {
          worst = ratio;
          where = `${song.channels[c]?.id} ${e.type} at ${e.frame}`;
        }
      }
      out.push({ boundaries, where, worst });
    }
    return out;
  }

  for (const chip of ["nes", ...CHIPS] as const) {
    it(`${chip}: no boundary step stands out from its neighbourhood`, () => {
      const scanned = scan(chip);
      // the scan must really have looked at note boundaries on some audible channels
      expect(scanned.length).toBeGreaterThanOrEqual(2);
      expect(scanned.reduce((n, r) => n + r.boundaries, 0)).toBeGreaterThan(8);
      for (const r of scanned) {
        expect(r.worst, r.where).toBeLessThan(1.6);
      }
    });
  }

  it("a legato retrigger on an FM voice is hidden by the declick offset", () => {
    const d = fixtureDemo("adlib");
    const s = createSynth({ sampleRate: 48_000 });
    s.loadSong(d.song, d.instruments);
    s.setMaster({ limiter: false });
    const id =
      Object.keys(d.instruments).find((k) => d.instruments[k]?.kind === "fm") ??
      "";
    s.noteOn(0, 72, 1, id);
    const before = runSynth(s, 4800);
    s.noteOn(0, 74, 1, id);
    const after = runSynth(s, 480);
    const lat = (s as unknown as { latency: number }).latency;
    const tail = before.left.subarray(before.left.length - 4);
    const joined = new Float32Array(tail.length + after.left.length);
    joined.set(tail);
    joined.set(after.left, tail.length);
    let step = 0;
    for (let i = lat; i < lat + 6; i += 1) {
      step = Math.max(
        step,
        Math.abs(
          (joined[tail.length + i] ?? 0) - (joined[tail.length + i - 1] ?? 0)
        )
      );
    }
    expect(step).toBeLessThan(0.1 * Math.max(peak([before.left]), 0.01) + 0.02);
  });
});
