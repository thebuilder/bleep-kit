import {
  CHIP_IDS,
  type ChipId,
  normalizeSfx,
  type Sfx,
  type SfxCategory,
} from "@bleepkit/core";
import { describe, expect, it } from "vitest";
import { FIELD_PATHS, getField } from "../src/fields.ts";
import { generateSfx, randomizeSfx, SFX_CATEGORIES } from "../src/index.ts";
import { totalDuration } from "../src/pitch.ts";
import { categoryRanges } from "../src/ranges.ts";

const SEEDS = Array.from({ length: 20 }, (_, i) => i * 7919 + 3);

function all(
  fn: (category: SfxCategory, chip: ChipId, seed: number, sfx: Sfx) => void
): void {
  for (const category of SFX_CATEGORIES) {
    for (const chip of CHIP_IDS) {
      for (const seed of SEEDS) {
        fn(category, chip, seed, generateSfx(category, { chip, seed }));
      }
    }
  }
}

describe("generateSfx", () => {
  it("exposes every category from the core types", () => {
    expect(SFX_CATEGORIES).toHaveLength(13);
  });

  it("normalizes with zero issues for every category, chip and 20 seeds", () => {
    all((category, chip, seed, sfx) => {
      const result = normalizeSfx(sfx);
      expect(
        result.issues,
        `${category}/${chip}/${seed}: ${JSON.stringify(result.issues)}`
      ).toEqual([]);
      expect(result.value).toEqual(sfx);
    });
  });

  it("fills the identity fields", () => {
    const sfx = generateSfx("coin", { name: "My coin", seed: 12 });
    expect(sfx.version).toBe(1);
    expect(sfx.category).toBe("coin");
    expect(sfx.chip).toBe("nes");
    expect(sfx.seed).toBe(12);
    expect(sfx.name).toBe("My coin");
    expect(generateSfx("laser", { seed: 5 }).name).toBe("Laser 5");
  });

  it("is deterministic: same seed, same document; other seeds differ", () => {
    all((category, chip, seed, sfx) => {
      expect(generateSfx(category, { chip, seed })).toEqual(sfx);
    });
    for (const category of SFX_CATEGORIES) {
      for (const chip of CHIP_IDS) {
        const docs = new Set(
          SEEDS.map((seed) =>
            JSON.stringify(generateSfx(category, { chip, seed }))
          )
        );
        expect(docs.size, `${category}/${chip}`).toBe(SEEDS.length);
      }
    }
  });

  it("keeps the envelope total inside the category duration and under 10 s", () => {
    all((category, chip, seed, sfx) => {
      const { duration } = categoryRanges(category);
      const total = totalDuration(sfx.envelope);
      expect(total, `${category}/${chip}/${seed}`).toBeLessThanOrEqual(
        duration.max + 1e-9
      );
      expect(total, `${category}/${chip}/${seed}`).toBeGreaterThanOrEqual(
        duration.min - 1e-9
      );
      expect(total).toBeLessThan(10);
    });
  });

  it("stays inside the category ranges on every chip", () => {
    all((category, chip, seed, sfx) => {
      const { fields } = categoryRanges(category);
      for (const path of FIELD_PATHS) {
        const v = getField(sfx, path);
        if (v !== null) {
          const range = fields[path];
          expect(
            v,
            `${category}/${chip}/${seed} ${path}`
          ).toBeGreaterThanOrEqual(range.min - 1e-9);
          expect(v, `${category}/${chip}/${seed} ${path}`).toBeLessThanOrEqual(
            range.max + 1e-9
          );
        }
      }
    });
  });

  it("never asks for a pitch floor that would cut the sound short", () => {
    all((_category, _chip, _seed, sfx) => {
      expect(sfx.frequency.min).toBe(0);
    });
  });

  it("keeps a usable volume", () => {
    all((category, chip, seed, sfx) => {
      expect(sfx.volume, `${category}/${chip}/${seed}`).toBeGreaterThanOrEqual(
        0.45
      );
    });
  });

  it("has a 32-step table exactly when the wave is wavetable, an fm patch exactly when fm", () => {
    all((_category, _chip, _seed, sfx) => {
      expect(sfx.table !== null).toBe(sfx.wave === "wave");
      expect(sfx.fm !== null).toBe(sfx.wave === "fm");
    });
  });

  it("gives 20 seeds that are usable but spread out in pitch and length", () => {
    for (const category of SFX_CATEGORIES) {
      const docs = SEEDS.map((seed) =>
        generateSfx(category, { chip: "nes", seed })
      );
      const starts = new Set(docs.map((d) => Math.round(d.frequency.start)));
      const lengths = new Set(
        docs.map((d) => Math.round(totalDuration(d.envelope) * 50))
      );
      expect(starts.size, `${category} pitches`).toBeGreaterThanOrEqual(8);
      expect(lengths.size, `${category} lengths`).toBeGreaterThanOrEqual(6);
    }
  });
});

describe("randomizeSfx", () => {
  it("keeps category, chip and name and is deterministic", () => {
    const base = generateSfx("zap", { chip: "c64", name: "Spark", seed: 4 });
    const a = randomizeSfx(base, 99);
    expect(a.category).toBe("zap");
    expect(a.chip).toBe("c64");
    expect(a.name).toBe("Spark");
    expect(a.seed).toBe(99);
    expect(randomizeSfx(base, 99)).toEqual(a);
    expect(randomizeSfx(base, 100)).not.toEqual(a);
    expect(normalizeSfx(a).issues).toEqual([]);
  });
});

describe("categoryRanges", () => {
  it("returns a fresh, complete table for every category", () => {
    for (const category of SFX_CATEGORIES) {
      const a = categoryRanges(category);
      expect(a.category).toBe(category);
      expect(Object.keys(a.fields)).toHaveLength(FIELD_PATHS.length);
      for (const path of FIELD_PATHS) {
        expect(a.fields[path].min).toBeLessThanOrEqual(a.fields[path].max);
      }
      a.fields.volume.max = -1;
      a.duration.max = -1;
      const b = categoryRanges(category);
      expect(b.fields.volume.max).toBeGreaterThan(0);
      expect(b.duration.max).toBeGreaterThan(0);
    }
  });
});
