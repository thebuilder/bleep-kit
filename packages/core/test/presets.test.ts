import { describe, expect, it } from "vitest";
import {
  bassKind,
  CHIP_IDS,
  type ChipId,
  chipProfile,
  INSTRUMENT_PRESETS,
  makeInstrument,
  normalizeInstrument,
  renderInstrumentNote,
} from "../src/index.ts";
import { GAMEBOY_BASS_TABLE } from "../src/presets-bass.ts";
import { bandEnergy, fftPeakHz, rms, toDb } from "./helpers.ts";

const SR = 48_000;
/** A-1 is 55 Hz and A-2 110 Hz (A-4 = 440 Hz, an octave is a factor of two): written out, not computed from the code. */
const A1 = { hz: 55, note: 33 };
const A2 = { hz: 110, note: 45 };

/** Render a preset note (1 s, then a 0.2 s release) and measure its first 32768 frames, attack included. */
function measure(chip: ChipId, note: number, preset: "bass" | "bass-pulse") {
  const kind = preset === "bass" ? bassKind(chip) : "pulse";
  const inst = normalizeInstrument(
    makeInstrument(kind, chip, preset, "probe")
  ).value;
  const r = renderInstrumentNote(inst, note, {
    chip,
    duration: 1,
    release: 0.2,
    sampleRate: SR,
  });
  const ch = r.channels[0] as Float32Array;
  const from = 0;
  const length = 32_768;
  return {
    below80:
      bandEnergy(ch, SR, 20, 80, from, length) /
      bandEnergy(ch, SR, 20, 20_000, from, length),
    below250:
      bandEnergy(ch, SR, 20, 250, from, length) /
      bandEnergy(ch, SR, 20, 20_000, from, length),
    peakHz: fftPeakHz(ch, SR, from, length),
    rmsDb: toDb(rms(ch, from, from + length)),
  };
}

describe("instrument presets", () => {
  it("make a valid instrument for every preset, on every kind of every chip, with no warnings", () => {
    for (const chip of CHIP_IDS) {
      for (const kind of chipProfile(chip).kinds) {
        for (const preset of INSTRUMENT_PRESETS) {
          const n = normalizeInstrument(
            makeInstrument(kind, chip, preset, `${chip} ${kind} ${preset}`)
          );
          expect(n.issues, `${chip} ${kind} ${preset}`).toEqual([]);
          expect(n.value.kind).toBe(kind);
          expect(n.value.chip).toBe(chip);
        }
      }
    }
  });

  it("give every chip a bass voice the chip has: triangle on the NES, the wave channel on the Game Boy, and so on", () => {
    expect(
      Object.fromEntries(CHIP_IDS.map((chip) => [chip, bassKind(chip)]))
    ).toEqual({
      adlib: "fm",
      c64: "sid",
      custom: "sid",
      gameboy: "wave",
      genesis: "fm",
      nes: "triangle",
      snes: "sample",
    });
    for (const chip of CHIP_IDS) {
      expect(chipProfile(chip).kinds).toContain(bassKind(chip));
    }
  });

  it.each(CHIP_IDS)(
    "%s bass at A-1 has its fundamental at 55 Hz and most of its energy below 250 Hz",
    (chip) => {
      const m = measure(chip, A1.note, "bass");
      expect(Math.abs(m.peakHz - A1.hz) / A1.hz).toBeLessThan(0.03);
      expect(m.below250).toBeGreaterThan(0.7);
      // the sound is audible and nowhere near clipping
      expect(m.rmsDb).toBeGreaterThan(-30);
      expect(m.rmsDb).toBeLessThan(-8);
    }
  );

  it("put most of a bass note at A-1 under 80 Hz on the chips whose bass is a plain low tone", () => {
    for (const chip of ["nes", "gameboy", "genesis", "adlib"] as const) {
      expect(measure(chip, A1.note, "bass").below80, chip).toBeGreaterThan(0.8);
    }
  });

  it("make bass-pulse a quiet 50% pulse that plays an octave up: its fundamental is at 110 Hz and it sits under the triangle bass", () => {
    for (const chip of ["nes", "gameboy"] as const) {
      const double = measure(chip, A2.note, "bass-pulse");
      expect(Math.abs(double.peakHz - A2.hz) / A2.hz, chip).toBeLessThan(0.03);
      expect(double.rmsDb, chip).toBeLessThan(
        measure(chip, A1.note, "bass").rmsDb - 6
      );
    }
    const inst = makeInstrument("pulse", "nes", "bass-pulse", "d");
    expect(inst.pulse).toEqual({ duty: 0.5 });
    expect(inst.volume).toBeLessThan(0.5);
  });

  it("play bass-pulse as the plain bass on a kind that has no pulse", () => {
    const plain = makeInstrument("fm", "genesis", "bass", "x");
    expect(makeInstrument("fm", "genesis", "bass-pulse", "x")).toEqual(plain);
  });

  it("make the NES bass a gate (the triangle has no volume), the Game Boy bass a fat wave table, the SID bass a filtered PWM pulse", () => {
    const tri = makeInstrument("triangle", "nes", "bass", "t");
    expect(tri.envelope.sustain).toBe(1);
    expect(tri.macros).toEqual({});
    const { sid } = makeInstrument("sid", "c64", "bass", "s");
    expect(sid?.waveforms).toEqual(["pulse"]);
    expect(sid?.filter.mode).toBe("lp");
    expect(sid?.pwmDepth).toBeGreaterThan(0);
    expect(sid?.pwmRate).toBeLessThan(2);
    expect(sid?.filter.resonance).toBeGreaterThan(0.2);
    expect(sid?.filter.resonance).toBeLessThan(0.7);
    expect(sid?.filter.sweep).toBeLessThan(0);
  });

  it("use FM feedback and a fast decaying modulator over a high sustain carrier on both FM chips", () => {
    for (const chip of ["genesis", "adlib"] as const) {
      const { fm } = makeInstrument("fm", chip, "bass", "f");
      const modulator = fm?.ops[0];
      const carrier = fm?.ops[fm.ops.length - 1];
      expect(fm?.feedback, chip).toBeGreaterThanOrEqual(4);
      expect(fm?.ops.length, chip).toBe(chip === "genesis" ? 4 : 2);
      expect(modulator?.sustainLevel, chip).toBeLessThan(0.2);
      expect(carrier?.sustainLevel, chip).toBeGreaterThan(0.7);
      expect(modulator?.decay, chip).toBeGreaterThan(carrier?.decay ?? 99);
    }
  });

  it("tune the SNES bass sample so a written note sounds at its pitch (the generator's saw is C-4, base note 60)", () => {
    const s = makeInstrument("sample", "snes", "bass", "b").sample;
    expect(s?.generator).toBe("bass");
    expect(s?.baseNote).toBe(60);
    expect(s?.loop).toBe(true);
  });
});

describe("the Game Boy bass wave table", () => {
  const table = GAMEBOY_BASS_TABLE;
  /** Amplitude of harmonic k of the 32 step table by a plain DFT. */
  const harmonic = (k: number) => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < table.length; i += 1) {
      const v = (table[i] ?? 0) - 7.5;
      re += v * Math.cos((2 * Math.PI * k * i) / table.length);
      im += v * Math.sin((2 * Math.PI * k * i) / table.length);
    }
    return (2 * Math.hypot(re, im)) / table.length;
  };

  it("is 32 steps of 4 bits that use the whole range", () => {
    expect(table).toHaveLength(32);
    expect(Math.min(...table)).toBe(0);
    expect(Math.max(...table)).toBe(15);
    for (const v of table) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("is fatter than a sine and rounder than a square: strong odd harmonics, the third 10 to 20 dB under the fundamental, no even ones", () => {
    const third = 20 * Math.log10(harmonic(3) / harmonic(1));
    expect(third).toBeLessThan(-10);
    expect(third).toBeGreaterThan(-20);
    expect(harmonic(2) / harmonic(1)).toBeLessThan(0.01);
    // against a sine of the same 4-bit range (amplitude 7.5): at least as much fundamental, never past the 15 steps
    expect(harmonic(1)).toBeGreaterThan(7.5);
  });

  it("is the table the Game Boy bass preset carries", () => {
    expect(makeInstrument("wave", "gameboy", "bass", "w").wave?.table).toEqual([
      ...table,
    ]);
  });
});
