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

  it("NES coins mostly use the two-step arpeggio and a pulse wave", () => {
    const coins = docs("coin", "nes");
    const stepped = coins.filter(
      (s) => s.arpeggio.steps.length === 1 && s.arpeggio.rate > 0
    );
    expect(stepped.length).toBeGreaterThanOrEqual(8);
    for (const sfx of stepped) {
      expect([5, 7, 4, 12, 9]).toContain(sfx.arpeggio.steps[0]);
      // exactly two notes long: the envelope ends before a third arpeggio step
      const total =
        sfx.envelope.attack + sfx.envelope.sustain + sfx.envelope.decay;
      expect(total * sfx.arpeggio.rate).toBeLessThan(3);
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

  it("c64 uses filter sweeps, the other 8-bit chips never touch a filter", () => {
    const c64 = SFX_CATEGORIES.flatMap((c) => docs(c, "c64"));
    expect(
      c64.filter(
        (s) => s.filter.lowpass !== null && s.filter.lowpassSweep !== 0
      ).length
    ).toBeGreaterThan(20);
    for (const chip of ["nes", "gameboy", "genesis", "adlib"] as const) {
      for (const category of SFX_CATEGORIES) {
        for (const sfx of docs(category, chip)) {
          expect(sfx.filter.lowpass, `${chip} ${category}`).toBeNull();
          expect(sfx.filter.highpass, `${chip} ${category}`).toBeNull();
          expect(sfx.phaser).toEqual({ offset: 0, sweep: 0 });
          expect(sfx.bitcrush).toEqual({ bits: null, rateDivide: 1 });
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
    for (const chip of ["nes", "gameboy"] as const) {
      for (const category of SFX_CATEGORIES) {
        for (const sfx of docs(category, chip)) {
          expect([0.125, 0.25, 0.5], `${chip} ${category}`).toContain(
            sfx.duty.start
          );
          expect(sfx.duty.sweep).toBe(0);
        }
      }
    }
    for (const category of SFX_CATEGORIES) {
      for (const sfx of docs(category, "genesis")) {
        expect(sfx.duty.start).toBe(0.5);
        expect(sfx.duty.sweep).toBe(0);
      }
    }
  });

  it("keeps pitches above the lowest note a chip's pulse or triangle can reach", () => {
    for (const category of SFX_CATEGORIES) {
      for (const sfx of docs(category, "nes")) {
        if (sfx.wave === "square") {
          expect(sfx.frequency.start, category).toBeGreaterThanOrEqual(56);
        }
      }
      for (const sfx of docs(category, "genesis")) {
        if (sfx.wave === "square") {
          expect(sfx.frequency.start, category).toBeGreaterThanOrEqual(109);
        }
      }
    }
  });

  it("only picks waves the chip has, and uses every chip's own waves somewhere", () => {
    for (const chip of CHIP_IDS) {
      const seen = new Set(
        SFX_CATEGORIES.flatMap((c) => docs(c, chip).map((s) => s.wave))
      );
      expect(seen.size, chip).toBeGreaterThanOrEqual(
        chip === "gameboy" ? 3 : 3
      );
    }
    const gb = SFX_CATEGORIES.flatMap((c) => docs(c, "gameboy"));
    expect(gb.some((s) => s.wave === "wave" && s.table?.length === 32)).toBe(
      true
    );
  });
});
