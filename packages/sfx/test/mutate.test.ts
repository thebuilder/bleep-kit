import { CHIP_IDS, normalizeSfx, type Sfx } from "@bleepkit/core";
import { describe, expect, it } from "vitest";
import { FIELD_PATHS, getField } from "../src/fields.ts";
import {
  generateSfx,
  mutateMany,
  mutateSfx,
  SFX_CATEGORIES,
} from "../src/index.ts";
import { totalDuration } from "../src/pitch.ts";
import { categoryRanges } from "../src/ranges.ts";

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

function eachSfx(fn: (sfx: Sfx) => void): void {
  for (const category of SFX_CATEGORIES) {
    for (const chip of CHIP_IDS) {
      for (const seed of SEEDS) {
        fn(generateSfx(category, { chip, seed }));
      }
    }
  }
}

describe("mutateSfx", () => {
  it("is the identity at amount 0", () => {
    eachSfx((sfx) => {
      expect(mutateSfx(sfx, { amount: 0, seed: 9 })).toEqual(sfx);
    });
  });

  it("is deterministic for a seed and varies across seeds", () => {
    const base = generateSfx("laser", { seed: 5 });
    expect(mutateSfx(base, { seed: 1 })).toEqual(mutateSfx(base, { seed: 1 }));
    const family = new Set(
      [1, 2, 3, 4, 5, 6].map((seed) =>
        JSON.stringify(mutateSfx(base, { seed }))
      )
    );
    expect(family.size).toBeGreaterThanOrEqual(5);
  });

  it("changes something at the default amount, and keeps identity fields", () => {
    eachSfx((sfx) => {
      const out = mutateSfx(sfx, { seed: 11 });
      expect(out).not.toEqual(sfx);
      expect(out.category).toBe(sfx.category);
      expect(out.chip).toBe(sfx.chip);
      expect(out.wave).toBe(sfx.wave);
      expect(out.name).toBe(sfx.name);
      expect(out.seed).toBe(sfx.seed);
    });
  });

  it("returns a normalized document with no issues", () => {
    eachSfx((sfx) => {
      for (const amount of [0.15, 0.6, 1]) {
        const out = mutateSfx(sfx, { amount, seed: 3 });
        expect(
          normalizeSfx(out).issues,
          `${sfx.category}/${sfx.chip} ${amount}`
        ).toEqual([]);
      }
    });
  });

  it("stays inside the category ranges and duration cap even at amount 1", () => {
    eachSfx((sfx) => {
      const ranges = categoryRanges(sfx.category);
      for (const amount of [0.15, 1]) {
        const out = mutateSfx(sfx, { amount, seed: 21 });
        for (const path of FIELD_PATHS) {
          const v = getField(out, path);
          if (v !== null) {
            const { min, max } = ranges.fields[path];
            expect(
              v,
              `${sfx.category}/${sfx.chip} ${path}`
            ).toBeGreaterThanOrEqual(min - 1e-9);
            expect(
              v,
              `${sfx.category}/${sfx.chip} ${path}`
            ).toBeLessThanOrEqual(max + 1e-9);
          }
        }
        expect(totalDuration(out.envelope)).toBeLessThanOrEqual(
          ranges.duration.max + 1e-9
        );
      }
    });
  });

  it("does not turn effects on or off", () => {
    eachSfx((sfx) => {
      const out = mutateSfx(sfx, { amount: 1, seed: 8 });
      expect(out.vibrato.depth > 0).toBe(sfx.vibrato.depth > 0);
      expect(out.arpeggio.steps.length).toBe(sfx.arpeggio.steps.length);
      expect(out.filter.lowpass === null).toBe(sfx.filter.lowpass === null);
      expect(out.filter.highpass === null).toBe(sfx.filter.highpass === null);
      expect(out.bitcrush.bits === null).toBe(sfx.bitcrush.bits === null);
      expect(out.table === null).toBe(sfx.table === null);
      expect(out.fm === null).toBe(sfx.fm === null);
      expect(out.frequency.min).toBe(sfx.frequency.min);
    });
  });

  it("makes small musical nudges at the default amount: pitch moves in whole semitones, not more than a fourth", () => {
    const base = generateSfx("coin", { seed: 2 });
    let moved = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const out = mutateSfx(base, { seed });
      const semis = 12 * Math.log2(out.frequency.start / base.frequency.start);
      if (Math.abs(semis) > 0.01) {
        moved += 1;
        expect(Math.abs(semis - Math.round(semis))).toBeLessThan(0.05);
        expect(Math.abs(semis)).toBeLessThanOrEqual(5);
      }
    }
    expect(moved).toBeGreaterThan(5);
  });

  it("nudges more at a higher amount", () => {
    const base = generateSfx("powerup", { seed: 4 });
    const spread = (amount: number): number => {
      let total = 0;
      for (let seed = 1; seed <= 40; seed += 1) {
        const out = mutateSfx(base, { amount, seed });
        total += Math.abs(out.envelope.decay - base.envelope.decay);
        total += Math.abs(out.frequency.slide - base.frequency.slide);
        total +=
          Math.abs(12 * Math.log2(out.frequency.start / base.frequency.start)) /
          12;
      }
      return total;
    };
    expect(spread(0.8)).toBeGreaterThan(spread(0.1));
  });

  it("keeps duty on the chip's list and wavetable entries 0 to 15", () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const nes = mutateSfx(generateSfx("blip", { chip: "nes", seed }), {
        amount: 1,
        seed,
      });
      expect([0.125, 0.25, 0.5]).toContain(nes.duty.start);
    }
    const gb = generateSfx("hit", { chip: "gameboy", seed: 31 });
    const table = generateSfx("custom", { chip: "custom", seed: 1 });
    expect(gb.chip).toBe("gameboy");
    for (let seed = 1; seed <= 30; seed += 1) {
      const out = mutateSfx(
        {
          ...table,
          fm: null,
          table: Array.from({ length: 32 }, () => 15),
          wave: "wave",
        },
        { amount: 1, seed }
      );
      expect(out.table).toHaveLength(32);
      expect(
        out.table?.every((n) => Number.isInteger(n) && n >= 0 && n <= 15)
      ).toBe(true);
    }
  });

  it("leaves a hand-edited value outside the category range where it is when it is not picked, and never pushes further out", () => {
    const base = generateSfx("blip", { seed: 6 });
    const edited: Sfx = {
      ...base,
      frequency: { ...base.frequency, start: 7900 },
    };
    for (let seed = 1; seed <= 20; seed += 1) {
      const out = mutateSfx(edited, { seed });
      expect(out.frequency.start).toBeLessThanOrEqual(7900);
    }
  });
});

describe("mutateMany", () => {
  it("returns a deterministic family of the requested size", () => {
    const base = generateSfx("jump", { chip: "snes", seed: 8 });
    const a = mutateMany(base, { count: 8, seed: 3 });
    const b = mutateMany(base, { count: 8, seed: 3 });
    expect(a).toHaveLength(8);
    expect(a).toEqual(b);
    expect(
      new Set(a.map((s) => JSON.stringify(s))).size
    ).toBeGreaterThanOrEqual(7);
    expect(mutateMany(base, { count: 0, seed: 3 })).toEqual([]);
    expect(mutateMany(base, { amount: 0, count: 3, seed: 3 })).toEqual([
      base,
      base,
      base,
    ]);
    expect(mutateMany(base, { amount: 0.5, count: 3, seed: 3 })).not.toEqual(
      a.slice(0, 3)
    );
  });
});
