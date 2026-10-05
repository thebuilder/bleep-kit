import {
  CHIP_IDS,
  type ChipId,
  type RenderResult,
  renderSfx,
  type SfxCategory,
} from "@bleepkit/core";
import { describe, expect, it } from "vitest";
import { generateSfx, SFX_CATEGORIES } from "../src/index.ts";
import { categoryRanges } from "../src/ranges.ts";

const SEEDS = [1, 2, 3, 4, 5];
const RATE = 44_100;
const MIN_PEAK = 0.1; // -20 dBFS
const CLIP = 0.999;

function peak(r: RenderResult): number {
  let p = 0;
  for (const ch of r.channels) {
    for (const v of ch) {
      p = Math.max(p, Math.abs(v));
    }
  }
  return p;
}

function render(
  category: SfxCategory,
  chip: ChipId,
  seed: number
): RenderResult {
  return renderSfx(generateSfx(category, { chip, seed }), { sampleRate: RATE });
}

describe("rendered sfx (real core)", () => {
  for (const category of SFX_CATEGORIES) {
    it(`${category}: every chip at several seeds is audible, unclipped and short enough`, () => {
      const { duration } = categoryRanges(category);
      for (const chip of CHIP_IDS) {
        for (const seed of SEEDS) {
          const r = render(category, chip, seed);
          const label = `${category}/${chip}/${seed}`;
          const p = peak(r);
          expect(p, `${label} peak`).toBeGreaterThan(MIN_PEAK);
          expect(p, `${label} clipping`).toBeLessThan(CLIP);
          // the envelope total plus the render tail and chip latency
          expect(r.frames / r.sampleRate, `${label} length`).toBeLessThan(
            duration.max + 0.4
          );
          expect(r.frames, `${label} frames`).toBeGreaterThan(0);
        }
      }
    });
  }

  it("renders the same bytes twice for the same document", () => {
    const sfx = generateSfx("explosion", { chip: "nes", seed: 9 });
    const a = renderSfx(sfx, { sampleRate: RATE });
    const b = renderSfx(sfx, { sampleRate: RATE });
    expect(a.frames).toBe(b.frames);
    expect(Array.from(a.channels[0] ?? [])).toEqual(
      Array.from(b.channels[0] ?? [])
    );
  });
});
