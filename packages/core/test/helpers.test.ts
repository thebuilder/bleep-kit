/* The shared helpers are the measuring instruments of the engine tests (hashes, spectra, levels, the block runner)
   and the fixtures are what the golden hashes pin. A wrong instrument lets an engine bug pass or a correct engine fail,
   so each one is checked here against a signal whose answer is known without running any of our code. */

import { describe, expect, it } from "vitest";
import type { EngineEvent, Synth } from "../src/index.ts";
import {
  CHIP_IDS,
  normalizeInstrument,
  normalizeSfx,
  normalizeSong,
} from "../src/index.ts";
import {
  bandEnergy,
  fftPeakHz,
  fixtureDemo,
  fixtureInstruments,
  fixtureJson,
  fixtureSfx,
  fixtureSong,
  hashChannels,
  peak,
  rms,
  runSynth,
  toDb,
  zeroCrossingHz,
} from "./helpers.ts";

const SR = 48_000;

function sine(hz: number, seconds = 1, amp = 1): Float32Array {
  const out = new Float32Array(Math.round(SR * seconds));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  }
  return out;
}

describe("hashChannels", () => {
  const bytes = (...b: number[]) => new Float32Array(new Uint8Array(b).buffer);

  it("is FNV-1a 32 bit over the raw bytes, channel after channel", () => {
    // reference values from the published FNV-1a definition, computed outside this code base
    expect(hashChannels([])).toBe("811c9dc5");
    expect(hashChannels([bytes(97, 98, 99, 100)])).toBe("ce3479bd");
    expect(
      hashChannels([bytes(97, 98, 99, 100), bytes(101, 102, 103, 104)])
    ).toBe("76daaa8d");
    expect(hashChannels([bytes(0, 0, 0, 0)])).toBe("4b95f515");
  });

  it("sees a one bit difference and a channel swap", () => {
    const a = new Float32Array([0.5, -0.25]);
    const b = new Float32Array([0.5, -0.25]);
    b[1] = Math.fround(-0.25 + 2 ** -23);
    expect(hashChannels([a])).not.toBe(hashChannels([b]));
    expect(hashChannels([a, b])).not.toBe(hashChannels([b, a]));
  });

  it("hashes a view over part of a buffer by its own bytes only", () => {
    const whole = new Float32Array([1, 2, 3, 4]);
    expect(hashChannels([whole.subarray(1, 3)])).toBe(
      hashChannels([new Float32Array([2, 3])])
    );
  });
});

describe("level helpers", () => {
  it("peak is the largest magnitude over every channel, 0 for nothing", () => {
    expect(
      peak([new Float32Array([0.1, -0.7, 0.3]), new Float32Array([0.5])])
    ).toBeCloseTo(0.7, 6);
    expect(peak([])).toBe(0);
    expect(peak([new Float32Array(8)])).toBe(0);
  });

  it("rms of a full scale sine is 1/sqrt 2, of a constant is the constant, and honours the range", () => {
    expect(rms(sine(1000))).toBeCloseTo(Math.SQRT1_2, 4);
    expect(rms(new Float32Array(10).fill(0.25))).toBeCloseTo(0.25, 6);
    const half = new Float32Array([1, 1, 0, 0]);
    expect(rms(half, 0, 2)).toBeCloseTo(1, 6);
    expect(rms(half, 2)).toBe(0);
    expect(rms(new Float32Array(0))).toBe(0);
  });

  it("toDb: unity is 0 dB, half is -6.02 dB, ten times is 20 dB, silence is finite", () => {
    expect(toDb(1)).toBe(0);
    expect(toDb(0.5)).toBeCloseTo(-6.0206, 4);
    expect(toDb(10)).toBeCloseTo(20, 9);
    expect(Number.isFinite(toDb(0))).toBe(true);
    expect(toDb(0)).toBeLessThan(-200);
  });
});

describe("spectrum helpers", () => {
  it("fftPeakHz finds the frequency of a sine to well under a cent, wherever it sits between bins", () => {
    for (const hz of [110, 440, 1000, 1234.5, 5000, 12_000]) {
      const found = fftPeakHz(sine(hz, 0.5), SR);
      expect(
        Math.abs(1200 * Math.log2(found / hz)),
        `${hz} Hz found as ${found}`
      ).toBeLessThan(1);
    }
  });

  it("fftPeakHz picks the louder of two tones and can look at a segment", () => {
    const mix = sine(440, 0.5);
    const loud = sine(3000, 0.5, 0.5);
    for (let i = 0; i < mix.length; i += 1) {
      mix[i] = (mix[i] ?? 0) * 0.2 + (loud[i] ?? 0);
    }
    expect(fftPeakHz(mix, SR)).toBeCloseTo(3000, -1);
    const halves = new Float32Array(SR);
    halves.set(sine(500, 0.5), 0);
    halves.set(sine(2000, 0.5), SR / 2);
    expect(fftPeakHz(halves, SR, 0, SR / 2)).toBeCloseTo(500, -1);
    expect(fftPeakHz(halves, SR, SR / 2, SR / 2)).toBeCloseTo(2000, -1);
  });

  it("bandEnergy puts a 1 kHz sine's energy in the band that holds it and almost none elsewhere", () => {
    const tone = sine(1000, 0.5);
    const inside = bandEnergy(tone, SR, 900, 1100);
    const above = bandEnergy(tone, SR, 3000, 4000);
    const below = bandEnergy(tone, SR, 100, 500);
    expect(inside).toBeGreaterThan(above * 1e4);
    expect(inside).toBeGreaterThan(below * 1e4);
  });

  it("bandEnergy scales with the square of the amplitude", () => {
    const ratio =
      bandEnergy(sine(1000, 0.5, 1), SR, 900, 1100) /
      bandEnergy(sine(1000, 0.5, 0.5), SR, 900, 1100);
    expect(ratio).toBeCloseTo(4, 3);
  });

  it("zeroCrossingHz counts rising crossings: a sine gives its frequency, silence gives 0", () => {
    expect(zeroCrossingHz(sine(440), SR)).toBeCloseTo(440, 0);
    expect(zeroCrossingHz(sine(3000, 0.2), SR)).toBeCloseTo(3000, -1);
    expect(zeroCrossingHz(new Float32Array(1000), SR)).toBe(0);
    expect(zeroCrossingHz(new Float32Array([-1, 1]), SR)).toBe(0);
  });
});

describe("runSynth", () => {
  /** A fake synth: writes a running counter as the left channel, minus the counter on the right, and reports one
      event per block through one reused object, as the real synth does. */
  function fakeSynth() {
    let frame = 0;
    const shared = { frame: 0, type: "row" } as unknown as EngineEvent;
    const calls: number[] = [];
    const synth = {
      process(
        left: Float32Array,
        right: Float32Array,
        n: number,
        out: EngineEvent[]
      ) {
        calls.push(n);
        for (let i = 0; i < n; i += 1) {
          left[i] = frame + i;
          right[i] = -(frame + i);
        }
        shared.frame = frame;
        out.push(shared);
        frame += n;
      },
    } as unknown as Synth;
    return { calls, synth };
  }

  it("concatenates the blocks, with a short final block, into buffers of exactly the frames asked for", () => {
    const { calls, synth } = fakeSynth();
    const run = runSynth(synth, 10, 4);
    expect(calls).toEqual([4, 4, 2]);
    expect([...run.left]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect([...run.right]).toEqual([-0, -1, -2, -3, -4, -5, -6, -7, -8, -9]);
  });

  it("keeps a copy of each event, since the synth reuses one object, and hands the synth an emptied list each block", () => {
    const { synth } = fakeSynth();
    const run = runSynth(synth, 12, 4);
    expect(run.events.map((e) => e.frame)).toEqual([0, 4, 8]);
  });

  it("defaults to 128 frame blocks", () => {
    const { calls, synth } = fakeSynth();
    runSynth(synth, 300);
    expect(calls).toEqual([128, 128, 44]);
  });
});

describe("fixtures", () => {
  it("each chip demo is a song, its instruments and a sfx for that chip, all valid as written", () => {
    for (const chip of CHIP_IDS.filter((c) => c !== "nes")) {
      const raw = fixtureJson(`demo-${chip}.json`) as {
        song: unknown;
        instruments: Record<string, unknown>;
        sfx: unknown;
      };
      const instruments = Object.fromEntries(
        Object.entries(raw.instruments).map(([id, doc]) => {
          const r = normalizeInstrument(doc);
          expect(r.issues, `${chip} instrument ${id}`).toEqual([]);
          return [id, r.value];
        })
      );
      expect(normalizeSfx(raw.sfx).issues, `${chip} sfx`).toEqual([]);
      expect(
        normalizeSong(raw.song, instruments).issues,
        `${chip} song`
      ).toEqual([]);
      const demo = fixtureDemo(chip);
      expect(demo.song.chip).toBe(chip);
      expect(demo.sfx.chip).toBe(chip);
      expect(Object.keys(demo.instruments).sort()).toEqual(
        Object.keys(raw.instruments).sort()
      );
    }
  });

  it("the fixture loaders give the nes title song with the lead, bass and drums, and the nes coin", () => {
    const { song, instruments } = fixtureSong();
    expect(song.chip).toBe("nes");
    expect(Object.keys(instruments).sort()).toEqual(["bass", "drums", "lead"]);
    expect(Object.keys(fixtureInstruments()).sort()).toEqual([
      "bass",
      "drums",
      "lead",
    ]);
    expect(fixtureSfx().category).toBe("coin");
    expect(fixtureSfx().chip).toBe("nes");
  });
});
