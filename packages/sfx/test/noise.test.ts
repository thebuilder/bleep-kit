import { type ChipId, mulberry32, type Sfx } from "@bleepkit/core";
import { describe, expect, it } from "vitest";
import { blank, makeCtx } from "../src/build.ts";
import { slideBy } from "../src/categories/flavors.ts";
import { CHIP_CAPS } from "../src/chips.ts";
import { generateSfx } from "../src/index.ts";

const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

function noiseDocs(category: "explosion" | "hit" | "step", chip: ChipId) {
  return SEEDS.map((seed) => generateSfx(category, { chip, seed })).filter(
    (s) => s.wave === "noise"
  );
}

/** Octaves the pitch path travels in `seconds` (the whole envelope by default); slides are octaves per second (2.4). */
function travel(
  sfx: Sfx,
  seconds = sfx.envelope.attack + sfx.envelope.sustain + sfx.envelope.decay
): number {
  return (
    sfx.frequency.slide * seconds +
    0.5 * sfx.frequency.deltaSlide * seconds * seconds
  );
}

describe("noise sweeps", () => {
  // Section 3.9: the Genesis noise channel cannot sweep on its own, so the core sweeps it through tone 3 mode and the
  // generators must keep giving its explosions and hits their falling pitch.
  it("Genesis noise explosions and hits still fall in pitch", () => {
    const explosions = noiseDocs("explosion", "genesis");
    const hits = noiseDocs("hit", "genesis");
    expect(explosions.length).toBeGreaterThan(10);
    expect(hits.length).toBeGreaterThan(3);
    for (const sfx of explosions) {
      expect(travel(sfx), `explosion ${sfx.seed}`).toBeLessThan(-0.5);
    }
    for (const sfx of hits) {
      expect(travel(sfx), `hit ${sfx.seed}`).toBeLessThan(0);
    }
  });

  // slideBy is the one place that knows a noise sweep may be impossible on a chip, so it gets direct cases.
  describe("slideBy", () => {
    function noiseCtx(canGlide: boolean) {
      const sfx: Sfx = blank("explosion", "nes", 1, "t");
      sfx.wave = "noise";
      const ctx = makeCtx(mulberry32(1), "nes", sfx);
      ctx.caps = { ...CHIP_CAPS.nes, noiseSweep: canGlide };
      return { ctx, sfx };
    }

    it("travels the asked octaves over the asked time, curve included", () => {
      const { ctx, sfx } = noiseCtx(true);
      slideBy(ctx, -2, 1, 0.3);
      // curve 0.3: 30 percent of the fall comes from acceleration, so the slide alone is 70 percent of it
      expect(sfx.frequency.slide).toBeCloseTo(-1.4, 9);
      expect(travel(sfx, 1)).toBeCloseTo(-2, 9);
    });

    it("leaves a noise sound at one rate on a chip that cannot glide it", () => {
      const { ctx, sfx } = noiseCtx(false);
      slideBy(ctx, -2, 1, 0.3);
      expect(sfx.frequency.slide).toBe(0);
      expect(sfx.frequency.deltaSlide).toBe(0);
    });

    it("still glides a tonal sound on that chip", () => {
      const sfx: Sfx = blank("laser", "nes", 1, "t");
      const ctx = makeCtx(mulberry32(1), "nes", sfx);
      ctx.caps = { ...CHIP_CAPS.nes, noiseSweep: false };
      slideBy(ctx, -2, 1, 0);
      expect(travel(sfx, 1)).toBeCloseTo(-2, 9);
    });
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

/** The highest pitch the sound reaches, with the slide sampled along the envelope, then arpeggio and vibrato on top. */
function peakHz(sfx: Sfx): number {
  const total = sfx.envelope.attack + sfx.envelope.sustain + sfx.envelope.decay;
  let octaves = 0;
  for (let i = 0; i <= 32; i += 1) {
    octaves = Math.max(octaves, travel(sfx, (total * i) / 32));
  }
  const arp = Math.max(0, ...sfx.arpeggio.steps);
  return sfx.frequency.start * 2 ** (octaves + (arp + sfx.vibrato.depth) / 12);
}

describe("FM sfx voices", () => {
  // Section 3.9: the modulator stays under 6 kHz and the Carson bandwidth under 40 kHz at the sound's highest pitch,
  // so a laser lands near a 4 kHz centroid instead of a screech. The limits here are a little looser than the 6000
  // and 40 000 the generator aims at, to allow its half-step ratio grid.
  it("keep the modulator under 6 kHz and the sidebands inside a 40 kHz bandwidth", () => {
    let checked = 0;
    for (const category of ["laser", "zap", "blip", "coin", "hit"] as const) {
      for (const chip of ["adlib", "genesis", "custom"] as const) {
        for (const seed of SEEDS) {
          const sfx = generateSfx(category, { chip, seed });
          if (sfx.wave !== "fm" || sfx.fm === null) {
            continue;
          }
          checked += 1;
          const label = `${chip} ${category} ${seed}`;
          const top = peakHz(sfx);
          expect(sfx.fm.ratio * top, label).toBeLessThan(6500);
          expect(
            2 * (sfx.fm.index + 1) * sfx.fm.ratio * top,
            label
          ).toBeLessThan(42_000);
        }
      }
    }
    // the loop must not pass by skipping every document
    expect(checked).toBeGreaterThan(100);
  });
});
