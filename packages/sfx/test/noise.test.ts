import { CHIP_IDS, type ChipId, mulberry32, type Sfx } from "@bleepkit/core";
import { describe, expect, it } from "vitest";
import { blank, makeCtx } from "../src/build.ts";
import { slideBy } from "../src/categories/flavors.ts";
import { CHIP_CAPS } from "../src/chips.ts";
import { generateSfx } from "../src/index.ts";
import { pitchAt } from "../src/pitch.ts";

const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

function noiseDocs(category: "explosion" | "hit" | "step", chip: ChipId) {
  return SEEDS.map((seed) => generateSfx(category, { chip, seed })).filter(
    (s) => s.wave === "noise"
  );
}

describe("noise sweeps", () => {
  it("every chip says whether its noise rate can glide", () => {
    for (const chip of CHIP_IDS) {
      expect(typeof CHIP_CAPS[chip].noiseSweep, chip).toBe("boolean");
    }
    // the Genesis sweeps through tone 3 mode, so it keeps its slides
    expect(CHIP_CAPS.genesis.noiseSweep).toBe(true);
  });

  it("a noise sound on a chip that cannot sweep it stays at one rate", () => {
    const sfx: Sfx = blank("explosion", "nes", 1, "t");
    sfx.wave = "noise";
    const ctx = makeCtx(mulberry32(1), "nes", sfx);
    slideBy(ctx, -2, 1, 0.3);
    expect(sfx.frequency.slide).not.toBe(0);
    const still = blank("explosion", "nes", 1, "t");
    still.wave = "noise";
    const fixed = makeCtx(mulberry32(1), "nes", still);
    fixed.caps = { ...CHIP_CAPS.nes, noiseSweep: false };
    slideBy(fixed, -2, 1, 0.3);
    expect(still.frequency.slide).toBe(0);
    expect(still.frequency.deltaSlide).toBe(0);
    // a tonal sound still glides
    const tone = blank("laser", "nes", 1, "t");
    const toneCtx = makeCtx(mulberry32(1), "nes", tone);
    toneCtx.caps = { ...CHIP_CAPS.nes, noiseSweep: false };
    slideBy(toneCtx, -2, 1, 0);
    expect(tone.frequency.slide).not.toBe(0);
  });

  it("Genesis explosions and hits sweep white noise, never the periodic register", () => {
    for (const category of ["explosion", "hit"] as const) {
      const docsOnGenesis = noiseDocs(category, "genesis");
      expect(docsOnGenesis.length, category).toBeGreaterThan(5);
      for (const sfx of docsOnGenesis) {
        expect(sfx.noise.mode, category).toBe("long");
      }
    }
  });

  it("NES and Game Boy booms start at the bottom of the noise table", () => {
    for (const chip of ["nes", "gameboy"] as const) {
      const starts: number[] = [];
      for (const sfx of noiseDocs("explosion", chip)) {
        // the crunch is the one bright flavor, and it is short-mode
        if (sfx.noise.mode === "long") {
          starts.push(sfx.frequency.start);
        }
      }
      expect(starts.length, chip).toBeGreaterThan(10);
      for (const hz of starts) {
        // 60 to 250 Hz; a fall too deep for the pitch floor lifts its start a little (fitPitch)
        expect(hz, chip).toBeGreaterThanOrEqual(59);
        expect(hz, chip).toBeLessThanOrEqual(400);
      }
      const inside = starts.filter((hz) => hz <= 251);
      expect(inside.length / starts.length, chip).toBeGreaterThan(0.85);
    }
  });

  it("NES and Game Boy footsteps keep their noise between 300 and 1500 Hz", () => {
    for (const chip of ["nes", "gameboy"] as const) {
      const steps = noiseDocs("step", chip);
      expect(steps.length).toBeGreaterThan(10);
      for (const sfx of steps) {
        expect(sfx.frequency.start, chip).toBeGreaterThanOrEqual(299);
        expect(sfx.frequency.start, chip).toBeLessThanOrEqual(1501);
      }
    }
  });
});

describe("FM sfx voices", () => {
  it("keep the modulator under 6 kHz and the sidebands inside a 40 kHz bandwidth", () => {
    for (const category of ["laser", "zap", "blip", "coin", "hit"] as const) {
      for (const chip of ["adlib", "genesis", "custom"] as const) {
        for (const seed of SEEDS) {
          const sfx = generateSfx(category, { chip, seed });
          if (sfx.wave !== "fm" || sfx.fm === null) {
            continue;
          }
          const top = Math.max(
            sfx.frequency.start,
            pitchAt(
              sfx.frequency,
              sfx.envelope.attack + sfx.envelope.sustain + sfx.envelope.decay
            )
          );
          const arp = Math.max(0, ...sfx.arpeggio.steps);
          const reach = top * 2 ** ((arp + sfx.vibrato.depth) / 12);
          expect(
            sfx.fm.ratio * reach,
            `${chip} ${category} ${seed}`
          ).toBeLessThan(6500);
          expect(
            2 * (sfx.fm.index + 1) * sfx.fm.ratio * reach,
            `${chip} ${category} ${seed}`
          ).toBeLessThan(42_000);
        }
      }
    }
  });
});
