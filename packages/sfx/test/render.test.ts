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

const SWEEP_TIMEOUT_MS = 60_000;

describe("rendered sfx (real core)", () => {
  for (const category of SFX_CATEGORIES) {
    it(
      `${category}: every chip at several seeds is audible, unclipped and short enough`,
      () => {
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
          }
        }
        // 35 renders per category: a few seconds on a fast machine, far more under coverage on a small CI runner
      },
      SWEEP_TIMEOUT_MS
    );
  }

  it("renders the same samples for the same document, whatever was rendered in between", () => {
    // section 3.10: a render is a pure function of its inputs; the noise registers of one render must not leak into the next
    const sfx = generateSfx("explosion", { chip: "nes", seed: 9 });
    const first = renderSfx(sfx, { sampleRate: RATE });
    renderSfx(generateSfx("explosion", { chip: "c64", seed: 3 }), {
      sampleRate: RATE,
    });
    renderSfx(generateSfx("hit", { chip: "genesis", seed: 4 }), {
      sampleRate: RATE,
    });
    const again = renderSfx(sfx, { sampleRate: RATE });
    expect(again.frames).toBe(first.frames);
    expect(again.channels).toHaveLength(first.channels.length);
    for (const [i, channel] of first.channels.entries()) {
      expect(again.channels[i]).toEqual(channel);
    }
  });
});

/** Rising zero crossings per second inside a window of the render (a simple pitch estimate for a clean pulse). */
function crossingHz(samples: Float32Array, from: number, to: number): number {
  const a = Math.floor(from * RATE);
  const b = Math.min(samples.length, Math.floor(to * RATE));
  let count = 0;
  let first = -1;
  let last = -1;
  for (let i = a + 1; i < b; i += 1) {
    if ((samples[i - 1] ?? 0) <= 0 && (samples[i] ?? 0) > 0) {
      count += 1;
      first = first < 0 ? i : first;
      last = i;
    }
  }
  return count > 1 ? ((count - 1) * RATE) / (last - first) : 0;
}

// The category descriptions promise a direction of travel; this measures it in the audio, not in the document: a pitch
// estimate over two windows of the NES square render.
describe("rendered pitch movement (NES square)", () => {
  function squareRender(category: SfxCategory, seed: number) {
    const sfx = generateSfx(category, { chip: "nes", seed });
    const total =
      sfx.envelope.attack + sfx.envelope.sustain + sfx.envelope.decay;
    const [channel] = renderSfx(sfx, { sampleRate: RATE }).channels;
    return { channel: channel ?? new Float32Array(), sfx, total };
  }

  it("a two-step coin rises to a second note the stated number of semitones above the first", () => {
    let checked = 0;
    for (let seed = 1; seed <= 30; seed += 1) {
      const { channel, sfx } = squareRender("coin", seed);
      const [step] = sfx.arpeggio.steps;
      if (
        sfx.wave !== "square" ||
        sfx.arpeggio.steps.length !== 1 ||
        step === undefined
      ) {
        continue;
      }
      checked += 1;
      const note = 1 / sfx.arpeggio.rate;
      const first = crossingHz(channel, 0.1 * note, 0.9 * note);
      const second = crossingHz(channel, 1.1 * note, 1.9 * note);
      // the NES period table detunes high notes by a little, so allow a few percent
      expect(
        first / sfx.frequency.start,
        `coin ${seed} first note`
      ).toBeGreaterThan(0.98);
      expect(
        first / sfx.frequency.start,
        `coin ${seed} first note`
      ).toBeLessThan(1.02);
      // a coin rises: by at least a major third
      expect(second / first, `coin ${seed}`).toBeGreaterThan(1.2);
      expect(second / first, `coin ${seed}`).toBeGreaterThan(
        2 ** (step / 12) * 0.97
      );
      expect(second / first, `coin ${seed}`).toBeLessThan(
        2 ** (step / 12) * 1.03
      );
    }
    expect(checked).toBeGreaterThan(8);
  });

  it("a jump is higher in the middle than near the start", () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const { channel, sfx, total } = squareRender("jump", seed);
      if (sfx.wave !== "square") {
        continue;
      }
      const early = crossingHz(channel, 0.05 * total, 0.25 * total);
      const middle = crossingHz(channel, 0.4 * total, 0.6 * total);
      expect(middle / early, `jump ${seed}`).toBeGreaterThan(1.1);
    }
  });

  it("a laser dives", () => {
    let checked = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const { channel, sfx, total } = squareRender("laser", seed);
      if (sfx.wave !== "square" || sfx.frequency.slide > 0) {
        continue;
      }
      checked += 1;
      const early = crossingHz(channel, 0.05 * total, 0.25 * total);
      const middle = crossingHz(channel, 0.4 * total, 0.6 * total);
      expect(middle / early, `laser ${seed}`).toBeLessThan(0.9);
    }
    expect(checked).toBeGreaterThan(5);
  });
});
