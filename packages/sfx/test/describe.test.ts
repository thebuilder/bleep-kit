import { CHIP_IDS, type ChipId, type Sfx } from "@bleepkit/core";
import { describe, expect, it } from "vitest";
import { describeSfx, generateSfx, SFX_CATEGORIES } from "../src/index.ts";
import { totalDuration } from "../src/pitch.ts";

/** A fully specified sound with every effect off, so each test switches on exactly what it is about. */
function plainSfx(over: Partial<Sfx> = {}): Sfx {
  return {
    arpeggio: { rate: 0, steps: [] },
    bitcrush: { bits: null, rateDivide: 1 },
    category: "laser",
    chip: "nes",
    duty: { start: 0.25, sweep: 0 },
    envelope: { attack: 0.01, decay: 0.2, punch: 0.3, sustain: 0.1 },
    filter: {
      highpass: null,
      highpassSweep: 0,
      lowpass: null,
      lowpassSweep: 0,
      resonance: 0,
    },
    fm: null,
    frequency: { deltaSlide: 0, min: 0, slide: 0, start: 440 },
    name: "Plain",
    noise: { mode: "long" },
    phaser: { offset: 0, sweep: 0 },
    repeat: { rate: 0 },
    seed: 1,
    table: null,
    version: 1,
    vibrato: { depth: 0, rate: 0 },
    volume: 0.6,
    wave: "square",
    ...over,
  };
}

const CHIP_PHRASES: Record<ChipId, string> = {
  adlib: "the AdLib",
  c64: "the C64",
  custom: "custom chip",
  gameboy: "the Game Boy",
  genesis: "the Genesis",
  nes: "the NES",
  snes: "the SNES",
};

const WAVE_WORDS: Record<Sfx["wave"], string> = {
  fm: "FM",
  noise: "noise",
  saw: "saw",
  sine: "sine",
  square: "square",
  triangle: "triangle",
  wave: "wavetable",
};

/** Octaves the pitch path travels over the whole envelope (slides are octaves per second). */
function travel(sfx: Sfx): number {
  const t = totalDuration(sfx.envelope);
  return sfx.frequency.slide * t + 0.5 * sfx.frequency.deltaSlide * t * t;
}

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

  it("states the headline, wave, pitch, envelope and volume of a known sound", () => {
    const text = describeSfx(plainSfx());
    // 0.01 + 0.1 + 0.2 s
    expect(text).toContain(
      "A medium-length square laser sound for the NES, 0.31 s long."
    );
    expect(text).toContain("Pulse wave with duty 25%.");
    expect(text).toContain("Pitch holds at A-4 (440 Hz).");
    expect(text).toContain(
      "Envelope: attack 10 ms, sustain 100 ms, punch 30% extra level at the start of sustain, decay 200 ms;"
    );
    expect(text).toContain("Volume 60%.");
  });

  it("states facts that match the document, for every category and chip", () => {
    for (const category of SFX_CATEGORIES) {
      for (const chip of CHIP_IDS) {
        for (let seed = 1; seed <= 3; seed += 1) {
          const sfx = generateSfx(category, { chip, seed });
          const text = describeSfx(sfx);
          const label = `${category}/${chip}/${seed}`;
          expect(text, label).toContain(CHIP_PHRASES[chip]);
          expect(text, label).toContain(
            `${WAVE_WORDS[sfx.wave]} ${category} sound`
          );
          const length = /(\d+(?:\.\d+)?) s long/.exec(text);
          // stated to the nearest hundredth of a second
          expect(
            Math.abs(Number(length?.[1]) - totalDuration(sfx.envelope)),
            label
          ).toBeLessThanOrEqual(0.0051);
          const volume = /Volume (\d+(?:\.\d+)?)%/.exec(text);
          expect(Number(volume?.[1]), label).toBeCloseTo(sfx.volume * 100, 0);
          // whole hertz, with a decimal below 100 Hz where a whole number would hide a semitone
          const { start } = sfx.frequency;
          const stated =
            start < 100 ? Math.round(start * 10) / 10 : Math.round(start);
          expect(text, label).toContain(`${stated} Hz`);
          // the direction word follows where the pitch actually goes
          if (travel(sfx) > 0.5) {
            expect(text, label).toContain("rising");
          } else if (travel(sfx) < -0.5) {
            expect(text, label).toContain("falling");
          } else if (Math.abs(travel(sfx)) < 0.1) {
            expect(text, label).not.toMatch(/rising|falling/);
          }
        }
      }
    }
  });

  it("picks the length word from the played duration", () => {
    const words: readonly (readonly [number, string])[] = [
      [0.05, "A very short "],
      [0.18, "A short "],
      [0.3, "A medium-length "],
      [0.5, "A medium-length "],
      [1, "A long "],
      [2, "A very long "],
    ];
    for (const [seconds, start] of words) {
      const text = describeSfx(
        plainSfx({
          envelope: {
            attack: 0,
            decay: seconds / 2,
            punch: 0,
            sustain: seconds / 2,
          },
        })
      );
      expect(text.startsWith(start), `${seconds} s`).toBe(true);
    }
  });

  it("reports sweep direction and size", () => {
    const up = plainSfx({
      envelope: { attack: 0, decay: 0.2, punch: 0, sustain: 0.3 },
      frequency: { deltaSlide: 0, min: 0, slide: 2, start: 220 },
    });
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

  it("describes a noise sound by its rate in Hz, not by note names", () => {
    const text = describeSfx(
      plainSfx({
        category: "explosion",
        envelope: { attack: 0, decay: 0.3, punch: 0, sustain: 0.2 },
        frequency: { deltaSlide: 0, min: 0, slide: -1, start: 300 },
        wave: "noise",
      })
    );
    expect(text).toContain(
      "Noise rate starts at 300 Hz and slides down 0.5 octaves to 212 Hz by the end"
    );
    expect(text).toContain("Noise in long mode");
    expect(text).not.toMatch(/Pitch (starts|holds)/);
    expect(text).not.toMatch(/[A-G][-#]\d/);
  });

  it("describes effects that are switched on and stays quiet about ones that are off", () => {
    const plain = describeSfx(plainSfx());
    expect(plain).not.toMatch(
      /Vibrato|Arpeggio|Phaser|Repeats|Lowpass|Highpass|Bitcrush/
    );
    const busy = describeSfx(
      plainSfx({
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
      })
    );
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

  it("describes noise modes, wavetable and FM voices", () => {
    const long = describeSfx(plainSfx({ wave: "noise" }));
    expect(long).toContain("Noise in long mode");
    const short = describeSfx(
      plainSfx({ noise: { mode: "short" }, wave: "noise" })
    );
    expect(short).toContain("Noise in short mode");
    expect(short).toContain("metallic noise laser sound");
    const table = Array.from({ length: 32 }, (_, i) => i % 16);
    const wavetable = describeSfx(plainSfx({ table, wave: "wave" }));
    expect(wavetable).toContain(
      `Wavetable voice (32 steps, 4-bit), table: ${table.join(" ")}.`
    );
    const fm = describeSfx(
      plainSfx({ fm: { index: 2, indexDecay: 0.3, ratio: 3.5 }, wave: "fm" })
    );
    expect(fm).toContain(
      "Two-operator FM, modulator ratio 3.5, index 2 decaying over 0.3 s"
    );
    expect(
      describeSfx(
        plainSfx({ fm: { index: 2, indexDecay: 0, ratio: 3.5 }, wave: "fm" })
      )
    ).toContain("held constant");
  });

  it("notes when a pitch floor stops the sound early, and only then", () => {
    const falling = plainSfx({
      envelope: { attack: 0, decay: 0.5, punch: 0, sustain: 0.5 },
      frequency: { deltaSlide: 0, min: 500, slide: -2, start: 1600 },
    });
    // 1600 Hz falling 2 octaves per second passes 500 Hz after log2(3.2) / 2 = 0.84 s
    const text = describeSfx(falling);
    expect(text).toContain(
      "The sound stops early at 0.84 s, when the pitch falls below 500 Hz."
    );
    // a floor the pitch never reaches (it ends at 400 Hz after the full second... above 100 Hz) says nothing
    expect(
      describeSfx({ ...falling, frequency: { ...falling.frequency, min: 100 } })
    ).not.toContain("stops early");
  });
});
