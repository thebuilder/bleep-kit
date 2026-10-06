import { CHIP_IDS, normalizeSfx, type Sfx } from "@bleepkit/core";
import { describe, expect, it, vi } from "vitest";
import { FIELD_PATHS, getField } from "../src/fields.ts";
import {
  generateSfx,
  mutateMany,
  mutateSfx,
  SFX_CATEGORIES,
} from "../src/index.ts";
import { totalDuration } from "../src/pitch.ts";
import { categoryRanges } from "../src/ranges.ts";

// mutateSfx hands its document to normalizeSfx before returning it, which would silently repair a bad nudge (an fm
// patch on the wrong wave, a table of the wrong length). Watching what goes in, with the real function still running,
// is the only way to see such a bug.
const normalizeCalls = vi.hoisted(
  () => [] as { issues: readonly unknown[]; input: unknown; output: unknown }[]
);
vi.mock("@bleepkit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bleepkit/core")>();
  return {
    ...actual,
    normalizeSfx: (sfx: Sfx) => {
      const result = actual.normalizeSfx(sfx);
      normalizeCalls.push({
        input: JSON.parse(JSON.stringify(sfx)),
        issues: result.issues,
        output: JSON.parse(JSON.stringify(result.value)),
      });
      return result;
    },
  };
});

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
/** Section 3.3: the duties an NES or Game Boy pulse offers. */
const PULSE_DUTIES = [0.125, 0.25, 0.5, 0.75];

// every category on every chip at 8 seeds, generated once; mutateSfx copies its input, so the sweeps can share them
let generated: Sfx[] | undefined;

function eachSfx(fn: (sfx: Sfx) => void): void {
  generated ??= SFX_CATEGORIES.flatMap((category) =>
    CHIP_IDS.flatMap((chip) =>
      SEEDS.map((seed) => generateSfx(category, { chip, seed }))
    )
  );
  for (const sfx of generated) {
    fn(sfx);
  }
}

// the sweeps below mutate thousands of documents: far more than the default test timeout allows on a small CI runner
// under coverage
const SWEEP_TIMEOUT_MS = 60_000;

/** How far a sound moved, as the sum over its numeric fields of the change in units of the category's range. */
function distance(a: Sfx, b: Sfx): number {
  const { fields } = categoryRanges(a.category);
  let total = 0;
  for (const path of FIELD_PATHS) {
    const x = getField(a, path);
    const y = getField(b, path);
    if (x !== null && y !== null) {
      const span = fields[path].max - fields[path].min;
      total += span > 0 ? Math.abs(x - y) / span : 0;
    }
  }
  return total;
}

describe("mutateSfx", { timeout: SWEEP_TIMEOUT_MS }, () => {
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

  it("builds documents that need no repair, at every amount", () => {
    eachSfx((sfx) => {
      for (const amount of [0.15, 0.6, 1]) {
        normalizeCalls.length = 0;
        const out = mutateSfx(sfx, { amount, seed: 3 });
        const label = `${sfx.category}/${sfx.chip} ${amount}`;
        // what the nudge produced, before normalize had a chance to fix it
        for (const call of normalizeCalls) {
          expect(call.issues, label).toEqual([]);
          expect(call.output, label).toEqual(call.input);
        }
        const result = normalizeSfx(out);
        expect(result.issues, label).toEqual([]);
        expect(result.value, label).toEqual(out);
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
      const label = `${sfx.category}/${sfx.chip}`;
      // an effect that is on stays on
      expect(out.vibrato.depth > 0, label).toBe(sfx.vibrato.depth > 0);
      expect(out.vibrato.rate > 0, label).toBe(sfx.vibrato.rate > 0);
      expect(out.arpeggio.steps.length, label).toBe(sfx.arpeggio.steps.length);
      expect(out.arpeggio.rate > 0, label).toBe(sfx.arpeggio.rate > 0);
      expect(out.repeat.rate > 0, label).toBe(sfx.repeat.rate > 0);
      expect(out.filter.lowpass === null, label).toBe(
        sfx.filter.lowpass === null
      );
      expect(out.filter.highpass === null, label).toBe(
        sfx.filter.highpass === null
      );
      expect(out.bitcrush.bits === null, label).toBe(
        sfx.bitcrush.bits === null
      );
      expect(out.table === null, label).toBe(sfx.table === null);
      expect(out.fm === null, label).toBe(sfx.fm === null);
      expect(out.frequency.min, label).toBe(sfx.frequency.min);
      // and one that is off stays off: a nudge of 0 would otherwise start a sweep, a comb or a resonance from nothing
      expect(out.duty.sweep === 0, label).toBe(sfx.duty.sweep === 0);
      expect(out.filter.lowpassSweep === 0, label).toBe(
        sfx.filter.lowpassSweep === 0
      );
      expect(out.filter.highpassSweep === 0, label).toBe(
        sfx.filter.highpassSweep === 0
      );
      expect(out.phaser.offset === 0 && out.phaser.sweep === 0, label).toBe(
        sfx.phaser.offset === 0 && sfx.phaser.sweep === 0
      );
      if (sfx.filter.lowpass === null) {
        expect(out.filter.resonance, label).toBe(sfx.filter.resonance);
      }
      if (sfx.bitcrush.bits === null) {
        expect(out.bitcrush.rateDivide, label).toBe(sfx.bitcrush.rateDivide);
      }
    });
  });

  it("keeps the pitch path above the lowest note the chip's oscillator can reach", () => {
    // the same hardware floors as the generator tests (clock over register width), so a nudge cannot ask for a note
    // the chip cannot play
    const floors: readonly (readonly [string, Sfx["wave"], number])[] = [
      ["nes", "square", 54.6],
      ["nes", "triangle", 27.3],
      ["gameboy", "square", 64],
      ["gameboy", "wave", 32],
      ["genesis", "square", 109.4],
    ];
    let checked = 0;
    eachSfx((sfx) => {
      const floor = floors.find(
        ([chip, wave]) => chip === sfx.chip && wave === sfx.wave
      )?.[2];
      if (floor === undefined) {
        return;
      }
      for (const seed of [1, 2, 3]) {
        const out = mutateSfx(sfx, { amount: 1, seed });
        const total = totalDuration(out.envelope);
        const { slide, deltaSlide } = out.frequency;
        let lowestOctave = 0;
        for (let i = 0; i <= 64; i += 1) {
          const t = (total * i) / 64;
          lowestOctave = Math.min(
            lowestOctave,
            slide * t + 0.5 * deltaSlide * t * t
          );
        }
        const lowest =
          out.frequency.start *
          2 ** (lowestOctave + Math.min(0, ...out.arpeggio.steps) / 12);
        checked += 1;
        expect(
          lowest,
          `${sfx.chip} ${sfx.wave} ${sfx.category} ${seed}`
        ).toBeGreaterThanOrEqual(floor * 0.99);
      }
    });
    expect(checked).toBeGreaterThan(500);
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
        total += distance(mutateSfx(base, { amount, seed }), base);
      }
      return total;
    };
    expect(spread(0.8)).toBeGreaterThan(spread(0.1));
  });

  it("keeps duty on the chip's list", () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      for (const chip of ["nes", "gameboy"] as const) {
        const out = mutateSfx(generateSfx("blip", { chip, seed }), {
          amount: 1,
          seed,
        });
        expect(PULSE_DUTIES, `${chip} ${seed}`).toContain(out.duty.start);
      }
      const genesis = mutateSfx(
        generateSfx("blip", { chip: "genesis", seed }),
        {
          amount: 1,
          seed,
        }
      );
      expect(genesis.duty.start, `genesis ${seed}`).toBe(0.5);
    }
  });

  it("keeps wavetable entries whole numbers from 0 to 15, at both ends of the range", () => {
    const base = generateSfx("custom", { chip: "custom", seed: 1 });
    for (const level of [0, 15]) {
      for (let seed = 1; seed <= 30; seed += 1) {
        const out = mutateSfx(
          {
            ...base,
            fm: null,
            table: Array.from({ length: 32 }, () => level),
            wave: "wave",
          },
          { amount: 1, seed }
        );
        expect(out.table).toHaveLength(32);
        expect(
          out.table?.every((n) => Number.isInteger(n) && n >= 0 && n <= 15),
          `level ${level} seed ${seed}`
        ).toBe(true);
      }
    }
  });

  it("does not snap a hand-edited value outside the category range back to its edge, nor push it further out", () => {
    const base = generateSfx("blip", { seed: 6 });
    const top = categoryRanges("blip").fields["frequency.start"].max;
    const handEdited = top + 1000;
    const edited: Sfx = {
      ...base,
      frequency: { ...base.frequency, start: handEdited },
    };
    const starts: number[] = [];
    for (let seed = 1; seed <= 20; seed += 1) {
      starts.push(mutateSfx(edited, { seed }).frequency.start);
    }
    expect(Math.max(...starts)).toBeLessThanOrEqual(handEdited);
    // most seeds do not pick the pitch, and those must leave it exactly where the person put it
    expect(starts.filter((hz) => hz === handEdited).length).toBeGreaterThan(5);
    // a nudge upwards stops at the hand-edited value, not at the range edge below it
    expect(starts).not.toContain(top);
  });
});

describe("mutateMany", () => {
  const base = generateSfx("jump", { chip: "snes", seed: 8 });

  it("returns a deterministic family of the requested size, of different sounds", () => {
    const a = mutateMany(base, { count: 8, seed: 3 });
    expect(a).toHaveLength(8);
    expect(mutateMany(base, { count: 8, seed: 3 })).toEqual(a);
    expect(
      new Set(a.map((s) => JSON.stringify(s))).size
    ).toBeGreaterThanOrEqual(7);
    expect(mutateMany(base, { count: 0, seed: 3 })).toEqual([]);
  });

  it("keeps the first variants when more are asked for", () => {
    // asking the studio for more variants must not reshuffle the ones already on screen
    expect(mutateMany(base, { count: 3, seed: 3 })).toEqual(
      mutateMany(base, { count: 8, seed: 3 }).slice(0, 3)
    );
  });

  it("passes the amount on to every variant", () => {
    expect(mutateMany(base, { amount: 0, count: 3, seed: 3 })).toEqual([
      base,
      base,
      base,
    ]);
    const total = (amount: number): number =>
      mutateMany(base, { amount, count: 20, seed: 3 }).reduce(
        (sum, variant) => sum + distance(variant, base),
        0
      );
    expect(total(1)).toBeGreaterThan(total(0.1));
  });
});
