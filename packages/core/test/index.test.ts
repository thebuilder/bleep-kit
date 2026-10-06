/* The two public entry points (architecture sections 1.1 and 1.2) and the package boundary of AGENTS.md: other
   packages import these names, so removing or retyping one breaks them, and a Node import or an eager wasm load in core
   breaks the browser studio. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as core from "../src/index.ts";
import * as tools from "../src/tools.ts";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

describe("@bleepkit/core entry point", () => {
  it("exports every function of section 1.1", () => {
    const functions = [
      "normalizeProject",
      "normalizeSfx",
      "normalizeInstrument",
      "normalizeSong",
      "defaultProject",
      "defaultSfx",
      "defaultInstrument",
      "defaultSong",
      "issuesToText",
      "parseEffect",
      "formatEffect",
      "parseRowString",
      "formatRowString",
      "noteToHz",
      "hzToNote",
      "noteName",
      "parseNoteName",
      "parseMml",
      "formatMml",
      "mmlToTrack",
      "patternToMml",
      "compileSong",
      "chipProfile",
      "chipChannels",
      "createSynth",
      "renderSfx",
      "renderSong",
      "renderInstrumentNote",
      "createScopeReader",
      "generateSample",
      "mulberry32",
      "hashString",
      "deriveSeed",
    ];
    const record = core as unknown as Record<string, unknown>;
    expect(
      functions.filter((name) => typeof record[name] !== "function")
    ).toEqual([]);
  });

  it("exports the constants of section 1.1 with the contract's values", () => {
    expect(core.FORMAT_VERSION).toBe(1);
    expect(core.PPQ).toBe(96);
    expect(core.SCOPE_FRAMES).toBe(2048);
    expect(core.CHIP_IDS).toEqual([
      "nes",
      "gameboy",
      "c64",
      "genesis",
      "adlib",
      "snes",
      "custom",
    ]);
    expect(core.CHANNEL_KINDS).toEqual([
      "pulse",
      "triangle",
      "noise",
      "wave",
      "sid",
      "fm",
      "sample",
    ]);
    expect(core.SFX_WAVES).toEqual([
      "square",
      "triangle",
      "saw",
      "sine",
      "noise",
      "wave",
      "fm",
    ]);
    expect(core.SFX_CATEGORIES).toHaveLength(13);
    expect(core.EFFECT_TYPES).toHaveLength(20);
    expect(core.SAMPLE_GENERATOR_IDS).toHaveLength(14);
    expect(typeof core.ENGINE_VERSION).toBe("string");
    expect(Object.keys(core.CHIPS).sort()).toEqual([...core.CHIP_IDS].sort());
    expect(Object.keys(core.SAMPLE_GENERATORS).sort()).toEqual(
      [...core.SAMPLE_GENERATOR_IDS].sort()
    );
  });
});

describe("@bleepkit/core/tools entry point", () => {
  it("exports every function of section 1.2", () => {
    const functions = [
      "encodeWav",
      "decodeWav",
      "encodeOgg",
      "encodeMp3",
      "analyze",
      "fft",
      "hann",
      "spectrogram",
      "trackPitch",
      "encodePng",
      "waveformImage",
      "spectrogramImage",
      "scopesImage",
      "resultToInterleaved",
      "interleavedToResult",
      "mixToMono",
      "formatDuration",
      "formatDb",
    ];
    const record = tools as unknown as Record<string, unknown>;
    expect(
      functions.filter((name) => typeof record[name] !== "function")
    ).toEqual([]);
  });
});

function sources(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sources(path, into);
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      into.push(path);
    }
  }
  return into;
}

describe("notes (section 1.1)", () => {
  it("noteToHz: 69 is 440 Hz, 60 is middle C, an octave doubles and cents are hundredths of a note", () => {
    expect(core.noteToHz(69)).toBe(440);
    expect(core.noteToHz(60)).toBeCloseTo(261.6256, 3);
    expect(core.noteToHz(57)).toBeCloseTo(220, 9);
    expect(core.noteToHz(81)).toBeCloseTo(880, 9);
    expect(core.noteToHz(69, 100)).toBeCloseTo(core.noteToHz(70), 9);
    expect(core.noteToHz(69, -50)).toBeCloseTo(core.noteToHz(68.5), 9);
  });

  it("hzToNote is the inverse, fractional, and -Infinity for no frequency", () => {
    expect(core.hzToNote(440)).toBe(69);
    expect(core.hzToNote(261.6256)).toBeCloseTo(60, 4);
    expect(core.hzToNote(440 * 2 ** (1 / 24))).toBeCloseTo(69.5, 9);
    expect(core.hzToNote(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(core.hzToNote(-5)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("noteName: 60 is C-4, 61 is C#4, the range ends and fractions round", () => {
    expect(core.noteName(60)).toBe("C-4");
    expect(core.noteName(61)).toBe("C#4");
    expect(core.noteName(69)).toBe("A-4");
    expect(core.noteName(59)).toBe("B-3");
    expect(core.noteName(0)).toBe("C--1");
    expect(core.noteName(127)).toBe("G-9");
    expect(core.noteName(71.6)).toBe("C-5");
    expect(core.NOTE_NAMES).toEqual([
      "C-",
      "C#",
      "D-",
      "D#",
      "E-",
      "F-",
      "F#",
      "G-",
      "G#",
      "A-",
      "A#",
      "B-",
    ]);
  });

  it("parseNoteName reads sharps as # or +, flats as b, and anything else is null", () => {
    expect(core.parseNoteName("C#4")).toBe(61);
    expect(core.parseNoteName("c+4")).toBe(61);
    expect(core.parseNoteName("Db4")).toBe(61);
    expect(core.parseNoteName("C-4")).toBe(60);
    expect(core.parseNoteName("A-4")).toBe(69);
    expect(core.parseNoteName("Cb4")).toBe(59);
    expect(core.parseNoteName("C--1")).toBe(0);
    expect(core.parseNoteName("G-9")).toBe(127);
    for (const bad of [
      "",
      "H-4",
      "C-",
      "4",
      "C#",
      "G#9",
      "C#-1x",
      "off",
      "...",
    ]) {
      expect(core.parseNoteName(bad), bad).toBeNull();
    }
  });

  it("every MIDI note's name parses back to the note", () => {
    for (let n = 0; n <= 127; n += 1) {
      expect(core.parseNoteName(core.noteName(n)), core.noteName(n)).toBe(n);
    }
  });
});

describe("seeds (section 1.1)", () => {
  it("mulberry32 gives the canonical sequence, floats in [0, 1)", () => {
    // reference values from the published mulberry32 algorithm, computed outside this code base
    const first = (seed: number) => {
      const next = core.mulberry32(seed);
      return [next(), next(), next()];
    };
    expect(first(1)).toEqual([
      0.627_073_940_588_161_3, 0.002_735_721_180_215_478,
      0.527_447_039_959_952_2,
    ]);
    expect(first(42)).toEqual([
      0.601_103_751_920_163_6, 0.448_290_558_997_541_67,
      0.852_465_793_490_409_9,
    ]);
    expect(first(0xde_ad_be_ef)).toEqual([
      0.941_369_614_098_221_1, 0.267_195_749_795_064_33, 0.772_033_357_527_107,
    ]);
    const next = core.mulberry32(7);
    for (let i = 0; i < 1000; i += 1) {
      const v = next();
      expect(v >= 0 && v < 1).toBe(true);
    }
  });

  it("two mulberry32 generators with one seed advance independently when interleaved", () => {
    const a = core.mulberry32(5);
    const b = core.mulberry32(5);
    const solo = core.mulberry32(5);
    const expected = [solo(), solo(), solo()];
    expect([a(), b(), a(), b(), a(), b()]).toEqual([
      expected[0],
      expected[0],
      expected[1],
      expected[1],
      expected[2],
      expected[2],
    ]);
  });

  it("hashString is FNV-1a 32 bit: the published test vectors", () => {
    expect(core.hashString("")).toBe(0x81_1c_9d_c5);
    expect(core.hashString("a")).toBe(0xe4_0c_29_2c);
    expect(core.hashString("foobar")).toBe(0xbf_9c_f9_68);
    // over UTF-16 code units, so a non ASCII id still hashes to an unsigned 32 bit number
    expect(core.hashString("\u00e9")).toBe(core.hashString("\u00e9"));
    expect(core.hashString("\u00e9")).toBeGreaterThan(0);
    expect(core.hashString("\u00e9")).toBeLessThanOrEqual(0xff_ff_ff_ff);
  });

  it("deriveSeed is stable and spreads: a child seed per (seed, salt) pair that rarely collides", () => {
    expect(core.deriveSeed(1, 3)).toBe(core.deriveSeed(1, 3));
    expect(core.deriveSeed(1, "noise")).toBe(core.deriveSeed(1, "noise"));
    expect(core.deriveSeed(1, 3)).not.toBe(core.deriveSeed(2, 3));
    expect(core.deriveSeed(1, 3)).not.toBe(core.deriveSeed(1, 4));
    expect(core.deriveSeed(1, "noise")).not.toBe(core.deriveSeed(1, "pulse1"));
    const seen = new Set<number>();
    for (let salt = 0; salt < 2000; salt += 1) {
      const d = core.deriveSeed(1, salt);
      expect(Number.isInteger(d) && d >= 0 && d <= 0xff_ff_ff_ff).toBe(true);
      seen.add(d);
    }
    expect(seen.size).toBe(2000);
    // consecutive channel indexes must not give correlated noise seeds: the first draws differ widely
    const draws = [0, 1, 2, 3].map((ch) =>
      core.mulberry32(core.deriveSeed(1, ch))()
    );
    expect(new Set(draws.map((v) => Math.floor(v * 16))).size).toBeGreaterThan(
      1
    );
  });
});

describe("package boundary of core", () => {
  const code = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const files = sources(SRC);

  it("scans the real source tree", () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => f.endsWith("engine/synth.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("tools/encode.ts"))).toBe(true);
  });

  it("imports nothing at runtime but relative files: no node: modules and no packages", () => {
    const bad: string[] = [];
    for (const file of files) {
      const text = code(readFileSync(file, "utf8"));
      // static imports and re-exports: `from "x"`; type-only imports vanish at runtime but must still be relative
      for (const m of text.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
        if (!m[1]?.startsWith(".")) {
          bad.push(`${file.slice(SRC.length)} imports "${m[1]}"`);
        }
      }
      for (const m of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
        if (m[1] !== "wasm-media-encoders") {
          bad.push(`${file.slice(SRC.length)} dynamically imports "${m[1]}"`);
        }
      }
      if (/\brequire\s*\(/.test(text)) {
        bad.push(`${file.slice(SRC.length)} calls require`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("loads wasm-media-encoders only lazily, from the encoders", () => {
    const users = files.filter((f) =>
      /wasm-media-encoders/.test(code(readFileSync(f, "utf8")))
    );
    expect(users.map((f) => f.slice(SRC.length))).toEqual(["tools/encode.ts"]);
  });
});
