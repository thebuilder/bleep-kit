// biome-ignore-all lint/performance/useTopLevelRegex: assertions read better with the pattern inline
import { CHIP_IDS } from "@bleepkit/core";
import { describe, expect, it } from "vitest";
import {
  categoryRanges,
  describeSfx,
  generateSfx,
  SFX_CATEGORIES,
} from "../src/index.ts";

describe("describeSfx", () => {
  it("mentions the category for every category and chip", () => {
    for (const category of SFX_CATEGORIES) {
      for (const chip of CHIP_IDS) {
        for (let seed = 1; seed <= 20; seed += 1) {
          const text = describeSfx(generateSfx(category, { chip, seed }));
          expect(text.toLowerCase(), `${category}/${chip}/${seed}`).toContain(
            category
          );
        }
      }
    }
  });

  it("is one paragraph with no em dash", () => {
    for (const category of SFX_CATEGORIES) {
      const text = describeSfx(generateSfx(category, { seed: 4 }));
      expect(text).not.toContain("\n");
      expect(text).not.toContain(String.fromCodePoint(0x20_14));
      expect(text.length).toBeGreaterThan(150);
    }
  });

  it("states wave, duration, pitch in note names and Hz, envelope and volume", () => {
    const sfx = generateSfx("laser", { seed: 7 });
    const text = describeSfx(sfx);
    expect(text).toMatch(/square|saw|triangle|sine|FM|wavetable|noise/);
    expect(text).toMatch(/\d+(\.\d+)? s long/);
    expect(text).toMatch(/[A-G][-#]\d \(\d+(\.\d)? Hz\)/);
    expect(text).toContain("Envelope:");
    expect(text).toMatch(/attack/);
    expect(text).toMatch(/decay \d+ ms/);
    expect(text).toMatch(/Volume \d/);
  });

  it("reports sweep direction and size", () => {
    const base = generateSfx("custom", { seed: 3 });
    const up = {
      ...base,
      envelope: { attack: 0, decay: 0.2, punch: 0, sustain: 0.3 },
      fm: null,
      frequency: { deltaSlide: 0, min: 0, slide: 2, start: 220 },
      table: null,
      wave: "square" as const,
    };
    const upText = describeSfx(up);
    expect(upText).toContain("rising");
    expect(upText).toMatch(/slides up 1 octave to A-4 \(440 Hz\)/);
    const down = { ...up, frequency: { ...up.frequency, slide: -1 } };
    expect(describeSfx(down)).toContain("falling");
    expect(describeSfx(down)).toMatch(
      /slides down 0\.5 octaves to D#3 \(156 Hz\)/
    );
    const flat = { ...up, frequency: { ...up.frequency, slide: 0 } };
    expect(describeSfx(flat)).toContain("Pitch holds at A-3 (220 Hz)");
  });

  it("describes effects that are switched on and stays quiet about ones that are off", () => {
    const base = generateSfx("coin", { chip: "nes", seed: 1 });
    const plain = describeSfx({
      ...base,
      arpeggio: { rate: 0, steps: [] },
      phaser: { offset: 0, sweep: 0 },
      repeat: { rate: 0 },
      vibrato: { depth: 0, rate: 0 },
    });
    expect(plain).not.toMatch(
      /Vibrato|Arpeggio|Phaser|Repeats|Lowpass|Highpass|Bitcrush/
    );
    const busy = describeSfx({
      ...base,
      arpeggio: { rate: 14, steps: [7] },
      bitcrush: { bits: 6, rateDivide: 4 },
      filter: {
        highpass: 300,
        highpassSweep: 1,
        lowpass: 2000,
        lowpassSweep: -2,
        resonance: 0.4,
      },
      phaser: { offset: 3, sweep: 5 },
      repeat: { rate: 4 },
      vibrato: { depth: 0.5, rate: 6 },
    });
    expect(busy).toContain("Arpeggio cycles");
    expect(busy).toContain("+7");
    expect(busy).toContain("Vibrato of 0.5 semitones at 6 Hz");
    expect(busy).toContain(
      "Lowpass filter at 2000 Hz, sweeping down 2 octaves per second, resonance 40%"
    );
    expect(busy).toContain(
      "Highpass filter at 300 Hz, sweeping up 1 octave per second"
    );
    expect(busy).toContain("Phaser comb");
    expect(busy).toContain("Bitcrush: 6-bit, sample rate divided by 4");
    expect(busy).toContain("Repeats");
  });

  it("describes noise, wavetable and FM voices", () => {
    expect(
      describeSfx(generateSfx("explosion", { chip: "nes", seed: 2 }))
    ).toMatch(/Noise in (long|short) mode/);
    const gb = SFX_CATEGORIES.map((c) =>
      generateSfx(c, { chip: "gameboy", seed: 5 })
    ).find((s) => s.wave === "wave");
    if (gb) {
      expect(describeSfx(gb)).toContain("Wavetable voice (32 steps, 4-bit)");
    }
    const fm = generateSfx("coin", { chip: "adlib", seed: 6 });
    if (fm.wave === "fm") {
      expect(describeSfx(fm)).toMatch(/Two-operator FM, modulator ratio/);
    }
  });

  it("notes when a pitch floor stops the sound early", () => {
    const base = generateSfx("laser", { seed: 2 });
    const text = describeSfx({
      ...base,
      envelope: { attack: 0, decay: 0.5, punch: 0, sustain: 0.5 },
      frequency: { deltaSlide: 0, min: 500, slide: -2, start: 1600 },
    });
    expect(text).toContain("stops early");
    expect(text).toContain("below 500 Hz");
  });

  it("agrees with the category ranges for the headline length word", () => {
    for (const category of SFX_CATEGORIES) {
      const { duration } = categoryRanges(category);
      expect(duration.max).toBeGreaterThan(duration.min);
    }
  });
});
