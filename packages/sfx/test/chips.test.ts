import {
  CHIP_IDS,
  type ChipId,
  noteToHz,
  type Sfx,
  type SfxCategory,
} from "@bleepkit/core";
import { describe, expect, it } from "vitest";
import { generateSfx, SFX_CATEGORIES } from "../src/index.ts";

const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

function docs(category: SfxCategory, chip: ChipId): Sfx[] {
  return SEEDS.map((seed) => generateSfx(category, { chip, seed }));
}

describe("chip character", () => {
  it("explosions use the noise channel wherever the chip has one", () => {
    for (const chip of ["nes", "gameboy", "c64", "snes"] as const) {
      for (const sfx of docs("explosion", chip)) {
        expect(sfx.wave, chip).toBe("noise");
      }
    }
    const genesis = docs("explosion", "genesis").filter(
      (s) => s.wave === "noise"
    );
    expect(genesis.length).toBeGreaterThanOrEqual(12);
  });

  it("AdLib has no noise, so its explosions are FM growls or low buzzes", () => {
    for (const sfx of docs("explosion", "adlib")) {
      expect(sfx.wave).not.toBe("noise");
      expect(sfx.frequency.start).toBeLessThan(200);
    }
    expect(
      docs("explosion", "adlib").filter((s) => s.wave === "fm").length
    ).toBeGreaterThanOrEqual(10);
  });

  it("NES coins mostly use the two-step arpeggio, on a pulse wave", () => {
    const coins = docs("coin", "nes");
    const stepped = coins.filter(
      (s) => s.arpeggio.steps.length === 1 && s.arpeggio.rate > 0
    );
    expect(stepped.length).toBeGreaterThanOrEqual(8);
    // the classic coin is a pulse blip
    expect(
      stepped.filter((s) => s.wave === "square").length / stepped.length
    ).toBeGreaterThanOrEqual(0.75);
    for (const sfx of stepped) {
      // the second note is higher: a third up to an octave
      expect(sfx.arpeggio.steps[0]).toBeGreaterThanOrEqual(4);
      expect(sfx.arpeggio.steps[0]).toBeLessThanOrEqual(12);
      // exactly two notes long: the second note starts, and the envelope ends before a third one would
      const total =
        sfx.envelope.attack + sfx.envelope.sustain + sfx.envelope.decay;
      expect(total * sfx.arpeggio.rate).toBeGreaterThan(2);
      expect(total * sfx.arpeggio.rate).toBeLessThan(3);
      // and a bright start note: above E5
      expect(sfx.frequency.start).toBeGreaterThan(noteToHz(76));
    }
  });

  it("FM chips get FM-flavored sounds", () => {
    for (const category of ["laser", "zap", "blip", "hit"] as const) {
      const adlib = docs(category, "adlib").filter((s) => s.wave === "fm");
      expect(adlib.length, `adlib ${category}`).toBeGreaterThanOrEqual(4);
      const genesis = docs(category, "genesis").filter((s) => s.wave === "fm");
      expect(genesis.length, `genesis ${category}`).toBeGreaterThanOrEqual(3);
    }
    expect(
      docs("coin", "genesis").filter((s) => s.wave === "fm").length
    ).toBeGreaterThanOrEqual(8);
  });

  it("c64 sweeps its filter", () => {
    const c64 = SFX_CATEGORIES.flatMap((c) => docs(c, "c64"));
    expect(
      c64.filter(
        (s) => s.filter.lowpass !== null && s.filter.lowpassSweep !== 0
      ).length
    ).toBeGreaterThan(20);
  });

  it("the NES, Game Boy, Genesis and AdLib have no filter, phaser or bitcrush to ask for", () => {
    for (const chip of ["nes", "gameboy", "genesis", "adlib"] as const) {
      for (const category of SFX_CATEGORIES) {
        for (const sfx of docs(category, chip)) {
          expect(sfx.filter.lowpass, `${chip} ${category}`).toBeNull();
          expect(sfx.filter.highpass, `${chip} ${category}`).toBeNull();
          expect(sfx.phaser, `${chip} ${category}`).toEqual({
            offset: 0,
            sweep: 0,
          });
          expect(sfx.bitcrush, `${chip} ${category}`).toEqual({
            bits: null,
            rateDivide: 1,
          });
        }
      }
    }
  });

  it("snes stands in for echo with a short phaser shimmer and bitcrush stays on custom", () => {
    const snes = SFX_CATEGORIES.flatMap((c) => docs(c, "snes"));
    expect(snes.filter((s) => s.phaser.offset !== 0).length).toBeGreaterThan(
      20
    );
    expect(snes.every((s) => s.bitcrush.bits === null)).toBe(true);
    const custom = docs("custom", "custom");
    expect(custom.some((s) => s.bitcrush.bits !== null)).toBe(true);
  });

  it("uses the duty values the chip offers", () => {
    // section 3.3: the NES and Game Boy pulses offer four duties, the Genesis PSG only 50 percent
    for (const chip of ["nes", "gameboy"] as const) {
      for (const category of SFX_CATEGORIES) {
        for (const sfx of docs(category, chip)) {
          expect([0.125, 0.25, 0.5, 0.75], `${chip} ${category}`).toContain(
            sfx.duty.start
          );
          expect(sfx.duty.sweep, `${chip} ${category}`).toBe(0);
        }
      }
    }
    for (const category of SFX_CATEGORIES) {
      for (const sfx of docs(category, "genesis")) {
        expect(sfx.duty.start, category).toBe(0.5);
        expect(sfx.duty.sweep, category).toBe(0);
      }
    }
  });

  // The lowest note each oscillator's period register can reach, from the clock and register width:
  // NES pulse 1789773 / (16 * 2048), NES triangle half of that, Game Boy pulse 131072 / 2048 and wave 65536 / 2048,
  // Genesis PSG 3579545 / (32 * 1023). A sound that slides or arpeggiates below it would be asking the chip for a
  // note it cannot play.
  const LOWEST_HZ: readonly (readonly [ChipId, Sfx["wave"], number])[] = [
    ["nes", "square", 54.6],
    ["nes", "triangle", 27.3],
    ["gameboy", "square", 64],
    ["gameboy", "wave", 32],
    ["genesis", "square", 109.4],
  ];

  it("keeps the whole pitch path above the lowest note the chip's oscillator can reach", () => {
    let checked = 0;
    for (const [chip, wave, floor] of LOWEST_HZ) {
      for (const category of SFX_CATEGORIES) {
        for (const sfx of docs(category, chip)) {
          if (sfx.wave !== wave) {
            continue;
          }
          checked += 1;
          const total =
            sfx.envelope.attack + sfx.envelope.sustain + sfx.envelope.decay;
          const { slide, deltaSlide } = sfx.frequency;
          let lowestOctave = 0;
          for (let i = 0; i <= 64; i += 1) {
            const t = (total * i) / 64;
            lowestOctave = Math.min(
              lowestOctave,
              slide * t + 0.5 * deltaSlide * t * t
            );
          }
          const lowestStep = Math.min(0, ...sfx.arpeggio.steps);
          const lowest =
            sfx.frequency.start * 2 ** (lowestOctave + lowestStep / 12);
          expect(
            lowest,
            `${chip} ${wave} ${category} ${sfx.seed}`
          ).toBeGreaterThanOrEqual(floor);
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it("only picks waves the chip has, and every wave a chip has turns up somewhere", () => {
    // section 2.4
    const ALLOWED: Record<ChipId, readonly Sfx["wave"][]> = {
      adlib: ["fm", "square", "sine", "saw"],
      c64: ["square", "saw", "triangle", "noise"],
      custom: ["square", "triangle", "saw", "sine", "noise", "wave", "fm"],
      gameboy: ["square", "wave", "noise"],
      genesis: ["square", "noise", "fm"],
      nes: ["square", "triangle", "noise"],
      snes: ["sine", "triangle", "saw", "square", "noise"],
    };
    for (const chip of CHIP_IDS) {
      const seen = new Set(
        SFX_CATEGORIES.flatMap((c) => docs(c, chip).map((s) => s.wave))
      );
      expect([...seen].sort(), chip).toEqual([...ALLOWED[chip]].sort());
    }
    const gb = SFX_CATEGORIES.flatMap((c) => docs(c, "gameboy"));
    const tables = gb.filter((s) => s.wave === "wave");
    expect(tables.length).toBeGreaterThan(0);
    for (const sfx of tables) {
      expect(sfx.table).toHaveLength(32);
    }
  });
});
