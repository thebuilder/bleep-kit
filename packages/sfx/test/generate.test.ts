import {
  CHIP_IDS,
  type ChipId,
  normalizeSfx,
  type Sfx,
  type SfxCategory,
} from "@bleepkit/core";
import { describe, expect, it, vi } from "vitest";
import { FIELD_PATHS, getField } from "../src/fields.ts";
import { generateSfx, randomizeSfx, SFX_CATEGORIES } from "../src/index.ts";
import { playedDuration, totalDuration } from "../src/pitch.ts";
import { categoryRanges } from "../src/ranges.ts";

// generateSfx hands its document to normalizeSfx before returning it, which silently repairs a wrong wave or a
// missing fm patch. Watching what goes in (the real function still runs) is the only way to see a generator bug the
// repair would hide.
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

const SEEDS = Array.from({ length: 20 }, (_, i) => i * 7919 + 3);

/** Every category on every chip at 20 seeds, generated once for the sweeps that only read them. */
let generated:
  | { category: SfxCategory; chip: ChipId; seed: number; sfx: Sfx }[]
  | undefined;

function everything() {
  generated ??= SFX_CATEGORIES.flatMap((category) =>
    CHIP_IDS.flatMap((chip) =>
      SEEDS.map((seed) => ({
        category,
        chip,
        seed,
        sfx: generateSfx(category, { chip, seed }),
      }))
    )
  );
  return generated;
}

function all(
  fn: (category: SfxCategory, chip: ChipId, seed: number, sfx: Sfx) => void
): void {
  for (const item of everything()) {
    fn(item.category, item.chip, item.seed, item.sfx);
  }
}

// the sweeps below render nothing but still build thousands of documents: far more than the default test timeout
// allows on a small CI runner under coverage
const SWEEP_TIMEOUT_MS = 60_000;

/** What the sound is, without the fields that differ between seeds by construction. */
function soundOf(sfx: Sfx): string {
  return JSON.stringify({ ...sfx, name: "", seed: 0 });
}

/** The same category on every chip at every seed. */
function across(category: SfxCategory): Sfx[] {
  return everything()
    .filter((item) => item.category === category)
    .map((item) => item.sfx);
}

/** Octaves the pitch path travels over the whole envelope (section 2.4: slides are octaves per second). */
function travel(sfx: Sfx): number {
  const t = totalDuration(sfx.envelope);
  return sfx.frequency.slide * t + 0.5 * sfx.frequency.deltaSlide * t * t;
}

describe("generateSfx", { timeout: SWEEP_TIMEOUT_MS }, () => {
  it("covers exactly the documented categories", () => {
    // the sweeps below iterate this list, so a category dropped from it would quietly lose all its coverage
    expect([...SFX_CATEGORIES].sort()).toEqual([
      "alarm",
      "blip",
      "coin",
      "custom",
      "door",
      "explosion",
      "hit",
      "jump",
      "laser",
      "powerup",
      "step",
      "teleport",
      "zap",
    ]);
  });

  it("builds documents that need no repair, for every category, chip and 20 seeds", () => {
    for (const category of SFX_CATEGORIES) {
      for (const chip of CHIP_IDS) {
        for (const seed of SEEDS) {
          normalizeCalls.length = 0;
          const sfx = generateSfx(category, { chip, seed });
          const label = `${category}/${chip}/${seed}`;
          // what the generator drew, before normalize had a chance to fix it
          for (const call of normalizeCalls) {
            expect(call.issues, label).toEqual([]);
            expect(call.output, label).toEqual(call.input);
          }
          const result = normalizeSfx(sfx);
          expect(result.issues, label).toEqual([]);
          expect(result.value, label).toEqual(sfx);
        }
      }
    }
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

  it("gives the same document for the same seed, however much was generated in between", () => {
    // the CLI and the studio share seeds, so a seed has to name one sound; hidden state in the generators would not
    for (const category of SFX_CATEGORIES) {
      for (const chip of CHIP_IDS) {
        const first = generateSfx(category, { chip, seed: 77 });
        generateSfx(category, { chip, seed: 78 });
        generateSfx("explosion", { chip: "snes", seed: 79 });
        expect(
          generateSfx(category, { chip, seed: 77 }),
          `${category}/${chip}`
        ).toEqual(first);
      }
    }
  });

  it("gives a different sound for every seed, on every chip", () => {
    // name and seed differ by construction, so compare what is left
    for (const category of SFX_CATEGORIES) {
      for (const chip of CHIP_IDS) {
        const sounds = new Set(
          SEEDS.map((seed) => soundOf(generateSfx(category, { chip, seed })))
        );
        expect(sounds.size, `${category}/${chip}`).toBe(SEEDS.length);
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

  // ranges.ts promises that generateSfx stays inside categoryRanges on every chip, because mutateSfx and the studio's
  // sliders rely on those ranges as the category's whole territory.
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

  it("never stops a sound before its envelope ends", () => {
    all((category, chip, seed, sfx) => {
      expect(playedDuration(sfx), `${category}/${chip}/${seed}`).toBeCloseTo(
        totalDuration(sfx.envelope),
        9
      );
    });
  });

  it("keeps a usable volume", () => {
    all((category, chip, seed, sfx) => {
      expect(sfx.volume, `${category}/${chip}/${seed}`).toBeGreaterThanOrEqual(
        0.45
      );
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

// What a listener expects of each category, taken from the category files' own descriptions rather than from their
// parameter tables: a coin and a jump go up, a laser, explosion, hit and footstep go down, an alarm lasts seconds.
describe("category character", { timeout: SWEEP_TIMEOUT_MS }, () => {
  it("coins rise and are bright: never falling, most with a stepped or gliding rise, starting above E5", () => {
    const coins = across("coin");
    let rising = 0;
    for (const sfx of coins) {
      expect(
        travel(sfx),
        `coin ${sfx.chip}/${sfx.seed}`
      ).toBeGreaterThanOrEqual(-1e-9);
      for (const step of sfx.arpeggio.steps) {
        expect(step, `coin ${sfx.chip}/${sfx.seed}`).toBeGreaterThan(0);
      }
      expect(sfx.frequency.start).toBeGreaterThanOrEqual(650);
      if (travel(sfx) > 0.1 || sfx.arpeggio.steps.length > 0) {
        rising += 1;
      }
    }
    // the ringing bell flavor holds one high note, so not every coin moves
    expect(rising / coins.length).toBeGreaterThan(0.5);
  });

  it("jumps sweep up, by at least a few semitones", () => {
    for (const sfx of across("jump")) {
      expect(travel(sfx), `jump ${sfx.chip}/${sfx.seed}`).toBeGreaterThan(0.15);
    }
  });

  it("powerups never fall and climb at least a third of an octave above where they start", () => {
    for (const sfx of across("powerup")) {
      const label = `powerup ${sfx.chip}/${sfx.seed}`;
      expect(travel(sfx), label).toBeGreaterThanOrEqual(-1e-9);
      const topStep = Math.max(0, ...sfx.arpeggio.steps);
      for (const step of sfx.arpeggio.steps) {
        expect(step, label).toBeGreaterThanOrEqual(0);
      }
      expect(Math.max(travel(sfx), 0) + topStep / 12, label).toBeGreaterThan(
        0.3
      );
    }
  });

  it("lasers mostly dive, and explosions, hits and footsteps always fall", () => {
    const lasers = across("laser");
    const diving = lasers.filter((s) => travel(s) < -0.3);
    expect(diving.length / lasers.length).toBeGreaterThan(0.8);
    for (const category of ["explosion", "hit", "step"] as const) {
      for (const sfx of across(category)) {
        expect(travel(sfx), `${category} ${sfx.chip}/${sfx.seed}`).toBeLessThan(
          -0.05
        );
      }
    }
  });

  it("zaps crackle with a fast vibrato and alarms never sit still", () => {
    for (const sfx of across("zap")) {
      expect(sfx.vibrato.rate, `zap ${sfx.chip}/${sfx.seed}`).toBeGreaterThan(
        15
      );
      expect(sfx.vibrato.depth).toBeGreaterThan(0);
    }
    for (const sfx of across("alarm")) {
      const changing =
        sfx.arpeggio.steps.length > 0 ||
        sfx.repeat.rate > 0 ||
        sfx.vibrato.depth >= 1;
      expect(changing, `alarm ${sfx.chip}/${sfx.seed}`).toBe(true);
    }
  });

  it("keeps each category the length its description gives", () => {
    const longest = (category: SfxCategory) =>
      Math.max(...across(category).map((s) => totalDuration(s.envelope)));
    const shortest = (category: SfxCategory) =>
      Math.min(...across(category).map((s) => totalDuration(s.envelope)));
    // blips 25 to 150 ms and footsteps 25 to 200 ms, hits short and punchy
    expect(longest("blip")).toBeLessThanOrEqual(0.15);
    expect(longest("step")).toBeLessThanOrEqual(0.2);
    expect(longest("hit")).toBeLessThanOrEqual(0.4);
    // alarms one to three seconds, explosions a quarter second and up
    expect(shortest("alarm")).toBeGreaterThanOrEqual(0.9);
    expect(longest("alarm")).toBeLessThanOrEqual(3);
    expect(shortest("explosion")).toBeGreaterThanOrEqual(0.25);
  });
});

describe("randomizeSfx", () => {
  it("keeps category, chip and name and gives the seed's own sound", () => {
    const base = generateSfx("zap", { chip: "c64", name: "Spark", seed: 4 });
    const a = randomizeSfx(base, 99);
    expect(a.category).toBe("zap");
    expect(a.chip).toBe("c64");
    expect(a.name).toBe("Spark");
    expect(a.seed).toBe(99);
    expect(randomizeSfx(base, 99)).toEqual(a);
    expect(soundOf(randomizeSfx(base, 100))).not.toBe(soundOf(a));
    expect(soundOf(a)).not.toBe(soundOf(base));
  });

  it("throws away hand edits and draws new values inside the category ranges", () => {
    const base = generateSfx("laser", { seed: 4 });
    const edited: Sfx = {
      ...base,
      frequency: { ...base.frequency, start: 7999 },
      volume: 0.05,
    };
    const { fields } = categoryRanges("laser");
    for (let seed = 1; seed <= 10; seed += 1) {
      const out = randomizeSfx(edited, seed);
      expect(out.volume).toBeGreaterThanOrEqual(0.45);
      expect(out.frequency.start).toBeLessThanOrEqual(
        fields["frequency.start"].max
      );
    }
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
