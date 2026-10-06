import { describe, expect, it } from "vitest";
import type { Instrument, Issue, Normalized, Row, Song } from "../src/index.ts";
import {
  defaultInstrument,
  defaultProject,
  defaultSfx,
  defaultSong,
  EFFECT_TYPES,
  FORMAT_VERSION,
  formatEffect,
  formatRowString,
  issuesToText,
  normalizeInstrument,
  normalizeProject,
  normalizeSfx,
  normalizeSong,
  parseEffect,
  parseRowString,
} from "../src/index.ts";
import { migrate } from "../src/normalize/migrate.ts";
import { fixtureInstruments, fixtureJson } from "./helpers.ts";

function has(
  r: Normalized<unknown>,
  severity: Issue["severity"],
  path: string,
  text?: RegExp
): void {
  const hit = r.issues.find(
    (i) =>
      i.path === path &&
      i.severity === severity &&
      (!text || text.test(i.message))
  );
  expect(
    hit,
    `${severity} at ${path} in\n${issuesToText(r.issues)}`
  ).toBeDefined();
}

describe("normalize contract", () => {
  it("returns the default document and one error for a non-object", () => {
    for (const input of [null, 3, "x", [], undefined]) {
      const r = normalizeProject(input);
      expect(r.ok).toBe(false);
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0]).toMatchObject({ path: "", severity: "error" });
      expect(r.value).toEqual(defaultProject());
    }
    expect(normalizeSfx(null).value).toEqual(defaultSfx());
    expect(normalizeInstrument(null).value).toEqual(defaultInstrument("pulse"));
    expect(normalizeSong(null).value).toEqual(defaultSong("nes"));
  });

  it("ok means no errors, warnings never block", () => {
    const warn = normalizeProject({
      extra: 1,
      master: { limiter: true, volume: 3 },
      version: 1,
    });
    expect(warn.ok).toBe(true);
    expect(warn.issues.every((i) => i.severity === "warning")).toBe(true);
    const err = normalizeProject({ chip: "zx", version: 1 });
    expect(err.ok).toBe(false);
  });

  it("returns a fresh object, never the input", () => {
    const input = defaultProject();
    const r = normalizeProject(input);
    expect(r.value).toEqual(input);
    expect(r.value).not.toBe(input);
    expect(r.value.master).not.toBe(input.master);
    const i = defaultInstrument("fm");
    const ri = normalizeInstrument(i);
    expect(ri.value.fm?.ops[0]).not.toBe(i.fm?.ops[0]);
  });

  it("is pure: the same input gives the same output and the input is not mutated", () => {
    const input = { bogus: true, name: "x", version: 1, volume: 9 };
    const copy = JSON.parse(JSON.stringify(input));
    const a = normalizeSfx(input);
    const b = normalizeSfx(input);
    expect(a).toEqual(b);
    expect(input).toEqual(copy);
  });

  it("rejects a version above FORMAT_VERSION with an error and accepts a missing one with a warning", () => {
    const high = { ...defaultProject(), version: FORMAT_VERSION + 1 };
    for (const r of [
      normalizeProject(high),
      normalizeSfx({ ...defaultSfx(), version: 2 }),
      normalizeInstrument({ ...defaultInstrument("pulse"), version: 9 }),
      normalizeSong({ ...defaultSong("nes"), version: 2 }),
    ]) {
      expect(r.ok).toBe(false);
      has(r, "error", "/version", /up to version 1/);
    }
    const missing = normalizeProject({ name: "x" });
    expect(missing.ok).toBe(true);
    has(missing, "warning", "/version", /missing/);
    expect(missing.value.version).toBe(FORMAT_VERSION);
  });

  it("migrate is the identity today", () => {
    const doc = { a: 1, version: 1 };
    expect(migrate(doc, 1)).toEqual(doc);
  });

  it("messages are imperative and name the value", () => {
    const r = normalizeProject({ master: { volume: 3 }, version: 1 });
    expect(r.issues[0]?.message).toBe("must be 0 to 1 (was 3)");
    expect(normalizeProject({ foo: 1, version: 1 }).issues[0]?.message).toBe(
      'unknown field "foo" was dropped'
    );
  });
});

describe("project", () => {
  it("fills the documented defaults silently", () => {
    const r = normalizeProject({ version: 1 });
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({
      chip: "nes",
      export: {
        baseUrl: "/audio/",
        dir: "../public/audio",
        embed: false,
        events: true,
        manifest: "../src/audio.ts",
        mp3Bitrate: 160,
        musicFormat: "ogg",
        oggQuality: 6,
        sfxFormat: "ogg",
      },
      master: { limiter: true, volume: 0.8 },
      sampleRate: 48_000,
      seed: 1,
      version: 1,
    });
    expect(typeof r.value.name).toBe("string");
  });

  it("clamps, replaces wrong types and drops unknown fields with the right severities", () => {
    const r = normalizeProject({
      chip: "zx",
      export: { dir: 4, mp3Bitrate: 5, oggQuality: 99, sfxFormat: "flac" },
      foo: 1,
      master: { limiter: "yes", volume: 3 },
      name: 3,
      sampleRate: 22_050,
      seed: -3,
      version: 1,
    });
    has(r, "warning", "/foo");
    has(r, "error", "/name", /string/);
    has(r, "error", "/chip");
    has(r, "error", "/sampleRate", /44100, 48000/);
    has(r, "warning", "/seed");
    has(r, "warning", "/master/volume", /0 to 1 \(was 3\)/);
    has(r, "error", "/master/limiter");
    has(r, "error", "/export/dir");
    has(r, "warning", "/export/oggQuality");
    has(r, "warning", "/export/mp3Bitrate");
    has(r, "error", "/export/sfxFormat");
    // clamped values sit at the documented ends, replaced ones fall back to the documented defaults
    expect(r.value).toMatchObject({
      chip: "nes",
      export: {
        dir: "../public/audio",
        mp3Bitrate: 64,
        oggQuality: 10,
        sfxFormat: "ogg",
      },
      master: { limiter: true, volume: 1 },
      sampleRate: 48_000,
      seed: 0,
    });
    expect(r.value.name).toBe(defaultProject().name);
    expect(r.ok).toBe(false);
  });

  it("accepts the example project from the contract with no issues", () => {
    const r = normalizeProject(fixtureJson("project.json"));
    expect(r.issues).toEqual([]);
    expect(r.value.chip).toBe("genesis");
    expect(r.value.sampleRate).toBe(48_000);
  });
});

describe("sfx", () => {
  // architecture 2.4: a disallowed wave becomes the first wave in the chip's allowed list
  it.each([
    ["nes", "fm", "square"],
    ["nes", "saw", "square"],
    ["gameboy", "fm", "square"],
    ["c64", "fm", "square"],
    ["genesis", "triangle", "square"],
    ["adlib", "noise", "fm"],
    ["snes", "wave", "sine"],
  ] as const)(
    "wave %s on %s is replaced by %s, the chip's first allowed wave",
    (chip, wave, first) => {
      const r = normalizeSfx({
        ...defaultSfx(),
        chip,
        fm: { index: 2, indexDecay: 0.3, ratio: 2 },
        table: new Array(32).fill(3),
        wave,
      });
      has(r, "error", "/wave", /not available/);
      expect(r.ok).toBe(false);
      expect(r.value.wave).toBe(first);
    }
  );

  it("keeps every allowed wave", () => {
    const allowed: Record<string, string[]> = {
      adlib: ["fm", "square", "sine", "saw"],
      c64: ["square", "saw", "triangle", "noise"],
      gameboy: ["square", "wave", "noise"],
      genesis: ["square", "noise", "fm"],
      nes: ["square", "triangle", "noise"],
      snes: ["sine", "triangle", "saw", "square", "noise"],
    };
    for (const [chip, waves] of Object.entries(allowed)) {
      for (const wave of waves) {
        const r = normalizeSfx({
          ...defaultSfx(),
          chip,
          fm: { index: 2, indexDecay: 0.3, ratio: 2 },
          table: new Array(32).fill(3),
          wave,
        });
        expect(r.value.wave, `${chip} ${wave}`).toBe(wave);
        expect(r.ok, `${chip} ${wave}\n${issuesToText(r.issues)}`).toBe(true);
      }
    }
  });

  it("requires fm for wave fm and a 32 entry table for wave wave", () => {
    has(
      normalizeSfx({ ...defaultSfx(), chip: "genesis", fm: null, wave: "fm" }),
      "error",
      "/fm"
    );
    has(
      normalizeSfx({
        ...defaultSfx(),
        chip: "gameboy",
        table: [1, 2],
        wave: "wave",
      }),
      "error",
      "/table",
      /32/
    );
    const ok = normalizeSfx({
      ...defaultSfx(),
      chip: "gameboy",
      table: new Array(32).fill(7),
      wave: "wave",
    });
    expect(ok.ok).toBe(true);
    expect(ok.value.table).toHaveLength(32);
  });

  it("nulls fm and table when the wave does not use them", () => {
    const r = normalizeSfx({
      ...defaultSfx(),
      fm: { index: 2, indexDecay: 1, ratio: 2 },
      table: new Array(32).fill(1),
      wave: "square",
    });
    expect(r.value.fm).toBeNull();
    expect(r.value.table).toBeNull();
    has(r, "warning", "/fm");
    has(r, "warning", "/table");
  });

  it("warns when the minimum frequency stops the sound at once", () => {
    const r = normalizeSfx({
      ...defaultSfx(),
      frequency: { deltaSlide: 0, min: 500, slide: 0, start: 100 },
    });
    has(r, "warning", "/frequency/min", /stops immediately/);
    expect(r.ok).toBe(true);
  });

  it("keeps the first 8 arpeggio steps and warns about the rest", () => {
    const r = normalizeSfx({
      ...defaultSfx(),
      arpeggio: { rate: 10, steps: [1, 2, 3, 4, 5, 6, 7, 8, 9, 99] },
    });
    expect(r.value.arpeggio.steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.issues).toEqual([
      {
        message: "must have at most 8 steps (had 10), extra steps were dropped",
        path: "/arpeggio/steps",
        severity: "warning",
      },
    ]);
  });

  it("clamps each arpeggio step to -24..24 with a warning at its index", () => {
    const r = normalizeSfx({
      ...defaultSfx(),
      arpeggio: { rate: 10, steps: [0, 99, -99, 24] },
    });
    expect(r.value.arpeggio.steps).toEqual([0, 24, -24, 24]);
    has(r, "warning", "/arpeggio/steps/1", /-24 to 24 \(was 99\)/);
    has(r, "warning", "/arpeggio/steps/2", /-24 to 24 \(was -99\)/);
    expect(r.issues).toHaveLength(2);
  });

  it("does not snap duty.start to the chip's duty list, it only warns", () => {
    // nes duties are 0.125, 0.25, 0.5 and 0.75: the snap happens at render time so a document keeps its intent
    const r = normalizeSfx({
      ...defaultSfx(),
      chip: "nes",
      duty: { start: 0.3, sweep: 0 },
    });
    expect(r.value.duty.start).toBe(0.3);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(1);
    has(r, "warning", "/duty/start", /0\.3.*snap/);
  });

  it("an envelope of more than 10 seconds in total is an error at /envelope (architecture 2.4)", () => {
    const total = (attack: number, sustain: number, decay: number) =>
      normalizeSfx({
        ...defaultSfx(),
        envelope: { attack, decay, punch: 0, sustain },
      });
    // 4 + 3 + 3 = 10 is allowed (each field is still clamped to its own range, with warnings)
    const ten = total(4, 3, 3);
    expect(ten.issues.filter((i) => i.severity === "error")).toEqual([]);
    const over = total(4, 4, 3);
    has(over, "error", "/envelope", /at most 10 seconds \(was 11\)/);
    expect(over.ok).toBe(false);
    // the document that comes out is still valid: every field inside its own range
    expect(over.value.envelope).toMatchObject({
      attack: 2,
      decay: 3,
      sustain: 3,
    });
    expect(total(2, 3, 3).issues).toEqual([]);
  });

  it("replaces an unknown category with custom (error)", () => {
    const r = normalizeSfx({ ...defaultSfx(), category: "bogus" });
    has(r, "error", "/category", /was "bogus"/);
    expect(r.value.category).toBe("custom");
  });

  it("drops unknown fields at any depth", () => {
    const r = normalizeSfx({
      ...defaultSfx(),
      extra: 1,
      filter: { ...defaultSfx().filter, zip: 1 },
    });
    has(r, "warning", "/extra");
    has(r, "warning", "/filter/zip");
    expect(
      (r.value as unknown as Record<string, unknown>).extra
    ).toBeUndefined();
  });

  it("accepts the coin example and round trips", () => {
    const first = normalizeSfx(fixtureJson("sfx-coin.json"));
    expect(first.issues).toEqual([]);
    const second = normalizeSfx(first.value);
    expect(second.issues).toEqual([]);
    expect(second.value).toEqual(first.value);
  });
});

describe("instrument", () => {
  it("nulls blocks that do not belong to the kind, with a warning", () => {
    const r = normalizeInstrument({
      ...defaultInstrument("pulse"),
      noise: { mode: "short" },
    });
    expect(r.value.noise).toBeNull();
    has(r, "warning", "/noise", /ignored for kind "pulse"/);
  });

  it("errors when the block the kind needs is missing", () => {
    const r = normalizeInstrument({
      ...defaultInstrument("pulse"),
      pulse: null,
    });
    expect(r.ok).toBe(false);
    expect(r.value.pulse).not.toBeNull();
    has(r, "error", "/pulse");
  });

  it("fills a default block silently when the kind needs one and the key is absent", () => {
    const base = Object.fromEntries(
      Object.entries(defaultInstrument("sid")).filter(([k]) => k !== "sid")
    ) as Partial<Instrument>;
    const r = normalizeInstrument(base);
    // an absent field is a default (silent); a present but wrong one is the error in the test above
    expect(r.issues).toEqual([]);
    expect(r.value.sid?.waveforms.length).toBeGreaterThanOrEqual(1);
  });

  it("a triangle needs no block and nulls any block it was given", () => {
    const r = normalizeInstrument({
      ...defaultInstrument("triangle"),
      pulse: { duty: 0.5 },
    });
    expect(r.ok).toBe(true);
    expect(r.value.pulse).toBeNull();
    expect(r.issues).toEqual([
      {
        message: 'is ignored for kind "triangle" and was set to null',
        path: "/pulse",
        severity: "warning",
      },
    ]);
  });

  it("requires 2 or 4 fm operators and matches the chip's operator count", () => {
    const { fm } = defaultInstrument("fm");
    expect(fm).not.toBeNull();
    const three = {
      ...defaultInstrument("fm"),
      fm: fm ? { ...fm, ops: fm.ops.slice(0, 3) } : null,
    };
    has(normalizeInstrument(three), "error", "/fm/ops", /2 or 4/);
    has(
      normalizeInstrument({ ...defaultInstrument("fm"), chip: "adlib" }),
      "error",
      "/fm/ops",
      /2 operators for chip "adlib"/
    );
    const two = defaultInstrument("fm");
    if (two.fm) {
      two.fm.ops = two.fm.ops.slice(0, 2);
      two.fm.algorithm = 1;
    }
    expect(normalizeInstrument({ ...two, chip: "genesis" }).ok).toBe(false);
    expect(normalizeInstrument({ ...two, chip: "adlib" }).ok).toBe(true);
    expect(normalizeInstrument({ ...two, chip: null }).ok).toBe(true);
  });

  it("validates macro lengths and loop and release indexes", () => {
    const r = normalizeInstrument({
      ...defaultInstrument("pulse"),
      macros: {
        arpeggio: { loop: 5, release: 2, values: [1, 2] },
        volume: { loop: 3, release: 9, values: [] },
      },
    });
    has(r, "error", "/macros/volume/values", /1 to 256/);
    has(r, "warning", "/macros/arpeggio/loop", /-1 to 1 \(was 5\)/);
    has(r, "warning", "/macros/arpeggio/release");
    expect(r.value.macros.arpeggio?.loop).toBe(1);
  });

  it("clamps sample params to the generator spec and rejects unknown generators", () => {
    const base = defaultInstrument("sample");
    const bad = normalizeInstrument({
      ...base,
      sample: {
        baseNote: 60,
        generator: "zzz",
        loop: false,
        params: {},
        seed: 1,
      },
    });
    has(bad, "error", "/sample/generator");
    const r = normalizeInstrument({
      ...base,
      sample: {
        baseNote: 60,
        generator: "kick",
        loop: false,
        params: { nope: 1, pitch: 5000 },
        seed: 1,
      },
    });
    has(r, "warning", "/sample/params/nope", /unknown field/);
    has(r, "warning", "/sample/params/pitch", /35 to 120/);
    expect(r.value.sample?.params.pitch).toBe(120);
    expect(r.value.sample?.params.nope).toBeUndefined();
  });

  it("checks the wavetable length", () => {
    const base = defaultInstrument("wave");
    const r = normalizeInstrument({ ...base, wave: { table: [1, 2, 3] } });
    has(r, "error", "/wave/table", /32/);
    expect(r.value.wave?.table).toHaveLength(32);
  });

  it("accepts every instrument fixture and round trips", () => {
    for (const f of ["lead", "bass", "drums", "fm-bass", "snes-pluck"]) {
      const first = normalizeInstrument(fixtureJson(`instrument-${f}.json`));
      expect(first.issues, f).toEqual([]);
      const second = normalizeInstrument(first.value);
      expect(second.issues, f).toEqual([]);
      expect(second.value).toEqual(first.value);
    }
  });
});

describe("effects", () => {
  // the code table of architecture 2.6: letter, type, and an example with distinct nibbles
  it.each([
    ["047", { type: "arp", x: 4, y: 7 }],
    ["1A3", { type: "slideUp", x: 10, y: 3 }],
    ["2A3", { type: "slideDown", x: 10, y: 3 }],
    ["312", { type: "portamento", x: 1, y: 2 }],
    ["437", { type: "vibrato", x: 3, y: 7 }],
    ["748", { type: "tremolo", x: 4, y: 8 }],
    ["A0F", { type: "volSlide", x: 0, y: 15 }],
    ["B02", { type: "jump", x: 0, y: 2 }],
    ["C00", { type: "halt", x: 0, y: 0 }],
    ["D10", { type: "skip", x: 1, y: 0 }],
    ["FF0", { type: "tempo", x: 15, y: 0 }],
    ["V03", { type: "duty", x: 0, y: 3 }],
    ["P80", { type: "pitch", x: 8, y: 0 }],
    ["S06", { type: "cut", x: 0, y: 6 }],
    ["G03", { type: "delay", x: 0, y: 3 }],
    ["Q43", { type: "noteSlideUp", x: 4, y: 3 }],
    ["R43", { type: "noteSlideDown", x: 4, y: 3 }],
    ["X80", { type: "pan", x: 8, y: 0 }],
    ["WFF", { type: "send", x: 15, y: 15 }],
    ["H04", { type: "retrigger", x: 0, y: 4 }],
  ] as const)(
    "string %s is the typed form %j and formats back",
    (code, typed) => {
      expect(parseEffect(code)).toEqual(typed);
      expect(formatEffect(typed)).toBe(code);
    }
  );

  it("the code table covers every effect type exactly once", () => {
    const seen = new Set<string>();
    for (const type of EFFECT_TYPES) {
      const code = formatEffect({ type, x: 1, y: 2 });
      expect(code).toMatch(/^[0-9A-Z]12$/);
      seen.add(code[0] as string);
    }
    expect(seen.size).toBe(EFFECT_TYPES.length);
  });

  it("rejects malformed effect codes", () => {
    // too short, too long, not hex, and letters or digits the code table does not use
    for (const bad of ["", "zzz", "A0", "A0FF", "900", "A0G", "E00", "Z00"]) {
      expect(parseEffect(bad), bad).toBeNull();
    }
  });

  it("row strings: note, instrument, volume and effects", () => {
    const { row } = parseRowString("C-4 lead vF A0F 047", 4);
    expect(row).toMatchObject({ inst: "lead", note: 60, row: 4, vol: 15 });
    expect(row.fx).toHaveLength(2);
    expect(parseRowString("OFF", 0).row.note).toBe("off");
    expect(parseRowString("REL", 0).row.note).toBe("release");
    expect(parseRowString("...", 0).row.note).toBeNull();
    expect(parseRowString("n60 . .", 0).row.note).toBe(60);
    expect(parseRowString("Db4", 0).row.note).toBe(61);
    expect(parseRowString("C#4 . . 047", 0).row.fx[0]).toMatchObject({
      type: "arp",
      x: 4,
      y: 7,
    });
    expect(parseRowString("C-4 . vC", 0).row.vol).toBe(12);
  });

  it("row strings read both . and -- as an empty field (architecture 2.6)", () => {
    const dots = parseRowString("C-4 . . 047", 0);
    const dashes = parseRowString("C-4 -- -- 047", 0);
    expect(dashes.issues).toEqual([]);
    expect(dashes.row).toEqual(dots.row);
    expect(dashes.row).toEqual({
      fx: [{ type: "arp", x: 4, y: 7 }],
      inst: null,
      note: 60,
      row: 0,
      vol: null,
    });
  });

  it("a row string that is not a note is an error at /s and leaves an empty row", () => {
    const { row, issues } = parseRowString("XX", 3);
    expect(issues).toEqual([
      {
        message: '"XX" is not a note (use C-4, C#4, n60, OFF, REL or ...)',
        path: "/s",
        severity: "error",
      },
    ]);
    expect(row).toMatchObject({ fx: [], inst: null, note: null, row: 3 });
  });

  it("formatRowString writes the canonical text of the contract's examples and round trips", () => {
    for (const s of [
      "C-4 lead vF A0F",
      "OFF",
      "REL",
      "E-5 . . 047",
      "G-5 . vC",
      "C-2 bass",
      "C#4 . . 047 130",
    ]) {
      const { row, issues } = parseRowString(s, 0);
      expect(issues).toEqual([]);
      expect(formatRowString(row)).toBe(s);
      expect(parseRowString(formatRowString(row), 0).row).toEqual(row);
    }
    // other spellings of the same row come out in the canonical one: sharp names for black keys
    expect(formatRowString(parseRowString("Db4", 0).row)).toBe("C#4");
    expect(formatRowString(parseRowString("n60 -- --", 0).row)).toBe("C-4");
  });
});

describe("song", () => {
  const nes = (): Song => defaultSong("nes");

  it("the compact string form and the typed form normalize to the same rows", () => {
    const typed: Row[] = [
      {
        fx: [{ type: "volSlide", x: 0, y: 15 }],
        inst: "lead",
        note: 64,
        row: 4,
        vol: 15,
      },
    ];
    const a = normalizeSong({
      ...nes(),
      patterns: {
        "pattern-1": {
          length: 16,
          tracks: { pulse1: [{ row: 4, s: "E-4 lead vF A0F" }] },
        },
      },
    });
    const b = normalizeSong({
      ...nes(),
      patterns: { "pattern-1": { length: 16, tracks: { pulse1: typed } } },
    });
    expect(a.issues).toEqual([]);
    expect(b.issues).toEqual([]);
    expect(a.value.patterns["pattern-1"]?.tracks.pulse1).toEqual(typed);
    expect(b.value).toEqual(a.value);
  });

  it("reads every form of a row's note", () => {
    const notes: unknown[] = [
      60,
      "C-4",
      "off",
      "OFF",
      "rel",
      "release",
      "...",
      "",
      null,
      60.4,
    ];
    const r = normalizeSong({
      ...nes(),
      patterns: {
        "pattern-1": {
          length: 16,
          tracks: {
            pulse1: notes.map((note, row) => ({
              fx: [],
              inst: null,
              note,
              row,
              vol: null,
            })),
          },
        },
      },
    });
    const rows = r.value.patterns["pattern-1"]?.tracks.pulse1 ?? [];
    expect(rows.map((x) => x.note)).toEqual([
      60,
      60,
      "off",
      "off",
      "release",
      "release",
      null,
      null,
      null,
      60,
    ]);
    // a fractional note number is rounded with a warning, nothing else is wrong
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("rejects a note that is not a note, and clamps one out of range", () => {
    const withNote = (note: unknown) =>
      normalizeSong({
        ...nes(),
        patterns: {
          "pattern-1": {
            length: 16,
            tracks: {
              pulse1: [{ fx: [], inst: null, note, row: 0, vol: null }],
            },
          },
        },
      });
    const high = withNote(300);
    expect(high.value.patterns["pattern-1"]?.tracks.pulse1?.[0]?.note).toBe(
      127
    );
    has(
      high,
      "warning",
      "/patterns/pattern-1/tracks/pulse1/0/note",
      /0 to 127 \(was 300\)/
    );
    expect(high.ok).toBe(true);
    for (const bad of ["H-9", "banana", {}, true]) {
      const r = withNote(bad);
      has(
        r,
        "error",
        "/patterns/pattern-1/tracks/pulse1/0/note",
        /note number 0 to 127/
      );
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("falls back to an order of every pattern, or of the first one, and says so when the order is empty", () => {
    const patterns = {
      a: { length: 16, tracks: {} },
      b: { length: 16, tracks: {} },
    };
    const missing = normalizeSong({ ...nes(), order: undefined, patterns });
    expect(missing.value.order).toEqual(["a", "b"]);
    const empty = normalizeSong({ ...nes(), order: [], patterns });
    expect(empty.value.order).toEqual(["a"]);
    has(empty, "error", "/order", /at least 1 pattern/);
    const none = normalizeSong({ ...nes(), order: [], patterns: {} });
    expect(none.value.order).toEqual(["pattern-1"]);
    expect(none.value.patterns["pattern-1"]?.length).toBe(64);
  });

  it("accepts string effects inside typed rows", () => {
    const r = normalizeSong({
      ...nes(),
      patterns: {
        "pattern-1": {
          length: 16,
          tracks: {
            pulse1: [
              {
                fx: ["047", { type: "arp", x: 1, y: 2 }],
                inst: null,
                note: 60,
                row: 0,
                vol: null,
              },
            ],
          },
        },
      },
    });
    expect(r.issues).toEqual([]);
    expect(r.value.patterns["pattern-1"]?.tracks.pulse1?.[0]?.fx).toEqual([
      { type: "arp", x: 4, y: 7 },
      { type: "arp", x: 1, y: 2 },
    ]);
  });

  it("rows: duplicates and rows beyond the pattern are errors, sorted output", () => {
    const row = (n: number, at: number) => ({
      fx: [],
      inst: null,
      note: n,
      row: at,
      vol: null,
    });
    const r = normalizeSong({
      ...nes(),
      loop: 0,
      order: ["a"],
      patterns: {
        a: {
          length: 8,
          tracks: { pulse1: [row(60, 3), row(62, 1), row(64, 1), row(65, 9)] },
        },
      },
    });
    has(r, "error", "/patterns/a/tracks/pulse1/2/row", /listed twice/);
    has(
      r,
      "error",
      "/patterns/a/tracks/pulse1/3/row",
      /below the pattern length 8/
    );
    // the first row 1 (note 62) wins over the duplicate (64), row 9 is dropped, and the rest is sorted
    expect(
      r.value.patterns.a?.tracks.pulse1?.map((x) => [x.row, x.note])
    ).toEqual([
      [1, 62],
      [3, 60],
    ]);
    has(r, "warning", "/patterns/a/tracks/pulse1", /must be sorted/);
  });

  it("a track key that is not a channel is dropped with a warning", () => {
    const r = normalizeSong({
      ...nes(),
      loop: 0,
      order: ["a"],
      patterns: { a: { length: 8, tracks: { bogus: [] } } },
    });
    has(r, "warning", "/patterns/a/tracks/bogus", /dropped/);
    expect(r.ok).toBe(true);
  });

  it("order entries must name a pattern and loop must be inside the order", () => {
    const r = normalizeSong({ ...nes(), loop: 5, order: ["pattern-1", "zz"] });
    has(r, "error", "/order/1", /does not exist/);
    has(r, "error", "/loop", /below 1/);
  });

  it("channel ids are unique and a subset of the chip's channels", () => {
    const base = nes();
    const dup = normalizeSong({
      ...base,
      channels: [base.channels[0], { ...base.channels[1], id: "pulse1" }],
    });
    has(dup, "error", "/channels/1/id", /listed twice/);
    const unknown = normalizeSong({
      ...base,
      channels: [base.channels[0], { ...base.channels[1], id: "fm1" }],
    });
    has(
      unknown,
      "error",
      "/channels/1/id",
      /unknown channel "fm1" for chip "nes"/
    );
  });

  it("custom songs declare their own channel ids and kinds", () => {
    const base = defaultSong("custom");
    const r = normalizeSong({
      ...base,
      channels: [
        {
          id: "lead",
          instrument: null,
          kind: "pulse",
          mml: null,
          muted: false,
          pan: 0,
          volume: 1,
        },
        {
          id: "pad",
          instrument: null,
          kind: "fm",
          mml: null,
          muted: false,
          pan: 0,
          volume: 1,
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.value.channels.map((c) => c.id)).toEqual(["lead", "pad"]);
  });

  it("a jump target must be inside the order", () => {
    const r = normalizeSong({
      ...nes(),
      loop: 0,
      order: ["a"],
      patterns: {
        a: {
          length: 8,
          tracks: {
            pulse1: [{ fx: ["B09"], inst: null, note: 60, row: 1, vol: null }],
          },
        },
      },
    });
    has(r, "error", "/patterns/a/tracks/pulse1/0/fx/0", /jump target 9/);
  });

  it("checks referenced instruments when the map is given, only the id shape otherwise", () => {
    const base = nes();
    const withInst = {
      ...base,
      channels: base.channels.map((c, i) =>
        i === 0 ? { ...c, instrument: "x" } : c
      ),
    };
    has(
      normalizeSong(withInst, {}),
      "error",
      "/channels/0/instrument",
      /does not exist/
    );
    has(
      normalizeSong(withInst, { x: defaultInstrument("fm") }),
      "error",
      "/channels/0/instrument",
      /instrument "x" is kind "fm" but channel "pulse1" is "pulse"/
    );
    expect(normalizeSong(withInst, { x: defaultInstrument("pulse") }).ok).toBe(
      true
    );
    expect(normalizeSong(withInst).ok).toBe(true);
    has(
      normalizeSong({
        ...base,
        channels: base.channels.map((c, i) =>
          i === 0 ? { ...c, instrument: "Bad Id" } : c
        ),
      }),
      "error",
      "/channels/0/instrument",
      /lowercase/
    );
  });

  it("row instrument references are checked with the map", () => {
    const r = normalizeSong(
      {
        ...nes(),
        patterns: {
          "pattern-1": {
            length: 8,
            tracks: {
              pulse1: [{ fx: [], inst: "ghost", note: 60, row: 0, vol: null }],
            },
          },
        },
      },
      {}
    );
    has(
      r,
      "error",
      "/patterns/pattern-1/tracks/pulse1/0/inst",
      /does not exist/
    );
  });

  it("limits a row to four effects and warns with the count it had", () => {
    const r = normalizeSong({
      ...nes(),
      patterns: {
        "pattern-1": {
          length: 8,
          tracks: {
            pulse1: [
              {
                fx: ["047", "130", "A0F", "B00", "V01"],
                inst: null,
                note: 60,
                row: 0,
                vol: null,
              },
            ],
          },
        },
      },
    });
    has(
      r,
      "warning",
      "/patterns/pattern-1/tracks/pulse1/0/fx",
      /at most 4 effects \(had 5\)/
    );
    expect(
      r.value.patterns["pattern-1"]?.tracks.pulse1?.[0]?.fx.map((e) => e.type)
    ).toEqual(["arp", "slideUp", "volSlide", "jump"]);
  });

  it("reports MML errors with the character offset at /channels/<i>/mml", () => {
    const base = nes();
    const r = normalizeSong({
      ...base,
      channels: base.channels.map((c, i) =>
        i === 0 ? { ...c, mml: "c d x e [" } : c
      ),
    });
    has(r, "error", "/channels/0/mml", /unknown command "x" at offset 4/);
    has(r, "error", "/channels/0/mml", /unclosed "\[" at offset 8/);
  });

  it("an all MML song with no patterns gets one 4 beat pattern per 4 beats, and tempo and loop from the MML", () => {
    const base = nes();
    // 8 eighth notes are 4 beats: one pattern of 16 rows (4 rows per beat); L after 4 eighths is inside it
    const r = normalizeSong({
      ...base,
      channels: base.channels.map((c, i) =>
        i === 0 ? { ...c, mml: "t140 l8 c d e f L g a b > c" } : c
      ),
      order: [],
      patterns: {},
    });
    expect(r.issues).toEqual([]);
    expect(r.value.tempo).toBe(140);
    expect(r.value.order).toHaveLength(1);
    expect(Object.values(r.value.patterns).map((p) => p.length)).toEqual([16]);
    expect(r.value.loop).toBe(0);
  });

  it("an all MML song longer than 4 beats gets a pattern for each 4 beats, and L picks the pattern it falls in", () => {
    const base = nes();
    // 10 quarter notes are 10 beats: 3 patterns (4 + 4 + 2 beats); L after beat 4 starts the second pattern
    const r = normalizeSong({
      ...base,
      channels: base.channels.map((c, i) =>
        i === 0 ? { ...c, mml: "l4 c c c c L c c c c c c" } : c
      ),
      loop: null,
      order: [],
      patterns: {},
    });
    expect(r.issues).toEqual([]);
    expect(r.value.order).toHaveLength(3);
    expect(new Set(r.value.order).size).toBe(3);
    expect(r.value.loop).toBe(1);
  });

  it("an MML tempo that differs from the song tempo is ignored with a warning when the song has patterns", () => {
    const base = nes();
    const r = normalizeSong({
      ...base,
      channels: base.channels.map((c, i) =>
        i === 0 ? { ...c, mml: "t90 c d" } : c
      ),
      loop: 0,
      order: ["a"],
      patterns: { a: { length: 16, tracks: {} } },
      tempo: 150,
    });
    expect(r.value.tempo).toBe(150);
    expect(r.issues).toEqual([
      {
        message:
          "MML sets tempo 90 but the song tempo is 150, the song tempo is used",
        path: "/tempo",
        severity: "warning",
      },
    ]);
  });

  describe("the MML loop point L against the document's loop", () => {
    // two sections of two bars each, so L after the first section is order boundary 1 (pulse 384 * 2 = 768 at 16 rows)
    const song = (mml: string, loop?: number | null) => {
      const base = nes();
      const doc: Record<string, unknown> = {
        ...base,
        channels: base.channels.map((c, i) => (i === 0 ? { ...c, mml } : c)),
        order: [],
        patterns: {},
      };
      if (loop === undefined) {
        doc.loop = undefined;
      } else {
        doc.loop = loop;
      }
      return normalizeSong(doc);
    };
    const MML = "l8 [c e g e]4 L [d f a f]4";
    const overrides = (r: Normalized<unknown>) =>
      r.issues.filter((i) => /overrides loop/.test(i.message));

    it("says nothing when the document has no loop or a null one", () => {
      for (const loop of [undefined, null]) {
        const r = song(MML, loop);
        expect(overrides(r), String(loop)).toEqual([]);
        expect(r.value.loop).not.toBeNull();
      }
    });

    it("L after 16 eighth notes (8 beats) is the start of the third 4 beat pattern", () => {
      // 32 eighths in all are 16 beats: 4 patterns, and L at beat 8 is order boundary 2
      const r = song(MML, null);
      expect(r.value.order).toHaveLength(4);
      expect(r.value.loop).toBe(2);
    });

    it("says nothing when the document already agrees with L", () => {
      const where = song(MML, null).value.loop;
      expect(where).toBe(2);
      const r = song(MML, where);
      expect(overrides(r)).toEqual([]);
      expect(r.value.loop).toBe(where);
    });

    it("warns, once, when the document names a different loop and takes L", () => {
      const r = song(MML, 0);
      expect(overrides(r)).toHaveLength(1);
      expect(r.issues).toEqual([
        {
          message:
            "MML loop point L overrides loop 0, the song loops to order 2",
          path: "/loop",
          severity: "warning",
        },
      ]);
      expect(r.value.loop).toBe(2);
    });

    it("an MML song with patterns says nothing when it agrees and one thing when it does not", () => {
      const doc = fixtureJson("song-title.json") as Record<string, unknown>;
      const first = normalizeSong(doc);
      expect(overrides(first)).toEqual([]);
      const idx = first.value.loop ?? 0;
      const other = idx === 0 ? 1 : 0;
      const r = normalizeSong({ ...doc, loop: other });
      // the title's L sits mid pattern, so the disagreement is reported as the rounding of L
      expect(r.issues.filter((i) => i.path === "/loop")).toHaveLength(1);
      expect(r.value.loop).toBe(idx);
    });
  });

  it("accepts the title song, alone and with its instruments, and round trips", () => {
    const instruments = fixtureInstruments();
    for (const map of [undefined, instruments]) {
      const first = normalizeSong(fixtureJson("song-title.json"), map);
      expect(first.issues).toEqual([]);
      expect(first.value.loop).toBe(1);
      expect(first.value.order).toEqual(["intro", "verse", "verse"]);
      const second = normalizeSong(first.value, map);
      expect(second.issues).toEqual([]);
      expect(second.value).toEqual(first.value);
    }
  });

  it("every default document round trips with zero issues", () => {
    for (const chip of [
      "nes",
      "gameboy",
      "c64",
      "genesis",
      "adlib",
      "snes",
      "custom",
    ] as const) {
      const first = normalizeSong(defaultSong(chip));
      expect(first.issues, chip).toEqual([]);
      expect(normalizeSong(first.value).value).toEqual(first.value);
    }
    for (const kind of [
      "pulse",
      "triangle",
      "noise",
      "wave",
      "sid",
      "fm",
      "sample",
    ] as const) {
      const first = normalizeInstrument(defaultInstrument(kind));
      expect(first.issues, kind).toEqual([]);
      expect(normalizeInstrument(first.value).value, kind).toEqual(first.value);
    }
    for (const chip of [
      "nes",
      "gameboy",
      "c64",
      "genesis",
      "adlib",
      "snes",
      "custom",
    ] as const) {
      const first = normalizeSfx(defaultSfx(chip));
      expect(first.issues, chip).toEqual([]);
      expect(normalizeSfx(first.value).value, chip).toEqual(first.value);
    }
    const project = normalizeProject(defaultProject());
    expect(project.issues).toEqual([]);
    expect(project.value).toEqual(defaultProject());
  });
});

/* The numeric ranges of architecture section 2.2, written out once more here on purpose: the expectation is the
   documented range, not whatever the normalizer clamps to. A value one step outside is clamped to the nearest end with
   a warning that names the range and the value that came in; the ends themselves are accepted without a word. */
type Range = readonly [
  path: string,
  min: number,
  max: number,
  extra?: Record<string, unknown>,
];

function withValue<T extends object>(doc: T, path: string, value: unknown): T {
  const copy = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
  const keys = path.split(".");
  let at = copy;
  for (const key of keys.slice(0, -1)) {
    at = at[key] as Record<string, unknown>;
  }
  at[keys.at(-1) as string] = value;
  return copy as T;
}

function valueAt(doc: object, path: string): unknown {
  let at: unknown = doc;
  for (const key of path.split(".")) {
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

const pointer = (path: string) => `/${path.replaceAll(".", "/")}`;

function checkRanges<T extends object>(
  ranges: readonly Range[],
  make: (path: string, extra: Record<string, unknown> | undefined) => T,
  run: (doc: T) => Normalized<unknown> & { value: unknown }
): void {
  it("a value outside each range is clamped to the nearest end with a warning", () => {
    for (const [path, min, max, extra] of ranges) {
      for (const [bad, clamped] of [
        [min - 1, min],
        [max + 1, max],
      ] as const) {
        const r = run(withValue(make(path, extra), path, bad));
        const hits = r.issues.filter((i) => i.path === pointer(path));
        expect(hits, `${path} = ${bad}\n${issuesToText(r.issues)}`).toEqual([
          {
            message: `must be ${min} to ${max} (was ${bad})`,
            path: pointer(path),
            severity: "warning",
          },
        ]);
        expect(valueAt(r.value as object, path), `${path} = ${bad}`).toBe(
          clamped
        );
        expect(r.ok, `${path} = ${bad}`).toBe(true);
      }
    }
  });

  it("both ends of each range are accepted without a word", () => {
    for (const [path, min, max, extra] of ranges) {
      for (const edge of [min, max]) {
        const r = run(withValue(make(path, extra), path, edge));
        expect(r.issues, `${path} = ${edge}`).toEqual([]);
        expect(valueAt(r.value as object, path), `${path} = ${edge}`).toBe(
          edge
        );
      }
    }
  });
}

describe("sfx ranges", () => {
  const fm = { index: 2, indexDecay: 0.3, ratio: 2 };
  const ranges: readonly Range[] = [
    ["volume", 0, 1],
    ["frequency.start", 20, 8000],
    ["frequency.min", 0, 8000, { "frequency.start": 8000 }],
    ["frequency.slide", -8, 8],
    ["frequency.deltaSlide", -16, 16],
    ["vibrato.depth", 0, 2],
    ["vibrato.rate", 0, 40],
    ["arpeggio.rate", 0, 60],
    ["envelope.attack", 0, 2],
    ["envelope.sustain", 0, 3],
    ["envelope.punch", 0, 1],
    ["envelope.decay", 0, 3],
    ["duty.start", 0, 1],
    ["duty.sweep", -4, 4],
    ["repeat.rate", 0, 60],
    ["phaser.offset", -20, 20],
    ["phaser.sweep", -40, 40],
    ["filter.lowpass", 50, 20_000],
    ["filter.lowpassSweep", -8, 8],
    ["filter.resonance", 0, 1],
    ["filter.highpass", 20, 10_000],
    ["filter.highpassSweep", -8, 8],
    ["bitcrush.bits", 1, 16],
    ["bitcrush.rateDivide", 1, 64],
    ["fm.ratio", 0.5, 12, { wave: "fm" }],
    ["fm.index", 0, 8, { wave: "fm" }],
    ["fm.indexDecay", 0, 2, { wave: "fm" }],
  ];
  checkRanges(
    ranges,
    (_path, extra) => {
      let doc: Record<string, unknown> = {
        ...defaultSfx(),
        chip: "genesis",
        fm,
        wave: "fm",
      };
      for (const [k, v] of Object.entries(extra ?? {})) {
        doc = withValue(doc, k, v);
      }
      return doc;
    },
    (doc) => normalizeSfx(doc)
  );
});

describe("instrument ranges", () => {
  const forKind = (kind: Parameters<typeof defaultInstrument>[0]) => () =>
    defaultInstrument(kind);
  describe("common fields and the pulse block", () => {
    checkRanges(
      [
        ["volume", 0, 1],
        ["pan", -1, 1],
        ["transpose", -48, 48],
        ["finetune", -100, 100],
        ["envelope.attack", 0, 4],
        ["envelope.decay", 0, 4],
        ["envelope.sustain", 0, 1],
        ["envelope.release", 0, 8],
        ["send.echo", 0, 1],
        ["send.reverb", 0, 1],
        ["pulse.duty", 0, 1],
      ],
      forKind("pulse"),
      (doc) => normalizeInstrument(doc)
    );
  });
  describe("the sid block", () => {
    checkRanges(
      [
        ["sid.pulseWidth", 0, 1],
        ["sid.pwmRate", 0, 20],
        ["sid.pwmDepth", 0, 1],
        ["sid.filter.cutoff", 0, 1],
        ["sid.filter.resonance", 0, 1],
        ["sid.filter.sweep", -0.05, 0.05],
      ],
      forKind("sid"),
      (doc) => normalizeInstrument(doc)
    );
  });
  describe("the fm block, 4 operators", () => {
    checkRanges(
      [
        ["fm.algorithm", 0, 7],
        ["fm.feedback", 0, 7],
        ["fm.ops.0.mult", 0, 15],
        ["fm.ops.0.detune", -3, 3],
        ["fm.ops.0.level", 0, 1],
        ["fm.ops.0.attack", 0, 31],
        ["fm.ops.0.decay", 0, 31],
        ["fm.ops.0.sustainLevel", 0, 1],
        ["fm.ops.0.sustainRate", 0, 31],
        ["fm.ops.0.release", 0, 15],
        ["fm.ops.0.keyScale", 0, 3],
        ["fm.ops.0.waveform", 0, 7],
      ],
      forKind("fm"),
      (doc) => normalizeInstrument(doc)
    );
  });
  describe("the fm lfo", () => {
    checkRanges(
      [
        ["fm.lfo.rate", 0, 20],
        ["fm.lfo.pitchDepth", 0, 100],
        ["fm.lfo.ampDepth", 0, 1],
      ],
      () => {
        const doc = defaultInstrument("fm");
        if (doc.fm) {
          doc.fm.lfo = { ampDepth: 0.5, pitchDepth: 10, rate: 5 };
        }
        return doc;
      },
      (doc) => normalizeInstrument(doc)
    );
  });
});

describe("song ranges", () => {
  describe("song, channel, row and master fields", () => {
    const withRow = () => {
      const doc = defaultSong("snes");
      doc.patterns = {
        "pattern-1": {
          length: 64,
          tracks: {
            [doc.channels[0]?.id ?? ""]: [
              { fx: [], inst: null, note: 60, row: 0, vol: 5 },
            ],
          },
        },
      };
      doc.order = ["pattern-1"];
      doc.master.echo = {
        delay: 0.2,
        feedback: 0.3,
        level: 0.3,
        lowpassHz: 4000,
      };
      doc.master.reverb = { damping: 0.5, level: 0.3, size: 0.5 };
      return doc;
    };
    const first = defaultSong("snes").channels[0]?.id ?? "";
    checkRanges(
      [
        ["tempo", 20, 400],
        ["rowsPerBeat", 1, 16],
        ["channels.0.volume", 0, 1],
        ["channels.0.pan", -1, 1],
        ["master.volume", 0, 1],
        ["master.echo.delay", 0.01, 1],
        ["master.echo.feedback", 0, 0.95],
        ["master.echo.level", 0, 1],
        ["master.reverb.size", 0, 1],
        ["master.reverb.damping", 0, 1],
        ["master.reverb.level", 0, 1],
        ["patterns.pattern-1.length", 1, 256],
        [`patterns.pattern-1.tracks.${first}.0.vol`, 0, 15],
      ],
      withRow,
      (doc) => normalizeSong(doc)
    );
  });
});

describe("more document rules", () => {
  const nes = () => defaultSong("nes");
  const oneRow = (row: Record<string, unknown>) => ({
    ...nes(),
    loop: 0,
    order: ["a"],
    patterns: { a: { length: 8, tracks: { pulse1: [row] } } },
  });

  it("keeps a valid id, leaves it absent when absent, and rejects a malformed one (architecture 2)", () => {
    const kept = normalizeSfx({ ...defaultSfx(), id: "my-coin-2" });
    expect(kept.issues).toEqual([]);
    expect((kept.value as { id?: string }).id).toBe("my-coin-2");
    expect("id" in normalizeSfx(defaultSfx()).value).toBe(false);
    for (const bad of ["Bad Id", "-lead", "a_b", "", "x".repeat(65), 7]) {
      const r = normalizeSfx({ ...defaultSfx(), id: bad });
      has(r, "error", "/id", /lowercase letters, digits and dashes/);
      expect("id" in r.value, JSON.stringify(bad)).toBe(false);
    }
  });

  it("a tempo effect below 0x20 is raised to 32 BPM with a warning", () => {
    const r = normalizeSong(
      oneRow({ fx: ["F10"], inst: null, note: 60, row: 0, vol: null })
    );
    has(
      r,
      "warning",
      "/patterns/a/tracks/pulse1/0/fx/0",
      /32 to 255 BPM \(was 16\)/
    );
    expect(r.value.patterns.a?.tracks.pulse1?.[0]?.fx).toEqual([
      { type: "tempo", x: 2, y: 0 },
    ]);
    expect(r.ok).toBe(true);
  });

  it("a row string overrides the other note fields and says so", () => {
    const r = normalizeSong(oneRow({ note: 62, row: 0, s: "C-4 lead vF" }));
    expect(r.value.patterns.a?.tracks.pulse1?.[0]).toMatchObject({
      inst: "lead",
      note: 60,
      vol: 15,
    });
    has(
      r,
      "warning",
      "/patterns/a/tracks/pulse1/0/note",
      /ignored because "s" is set/
    );
  });

  it("pattern tracks of a channel that has MML are ignored with a warning", () => {
    const base = nes();
    const r = normalizeSong({
      ...nes(),
      channels: base.channels.map((c, i) =>
        i === 0 ? { ...c, mml: "c d" } : c
      ),
      loop: 0,
      order: ["a"],
      patterns: {
        a: {
          length: 8,
          tracks: {
            pulse1: [{ fx: [], inst: null, note: 60, row: 0, vol: null }],
          },
        },
      },
    });
    has(
      r,
      "warning",
      "/patterns/a/tracks/pulse1",
      /ignored because channel "pulse1" has MML/
    );
    expect(r.ok).toBe(true);
  });

  it("a channel kind that does not match the chip's channel is replaced with a warning", () => {
    const base = nes();
    const r = normalizeSong({
      ...base,
      channels: base.channels.map((c, i) =>
        i === 0 ? { ...c, kind: "noise" } : c
      ),
    });
    has(
      r,
      "warning",
      "/channels/0/kind",
      /does not match channel "pulse1", using "pulse"/
    );
    expect(r.value.channels[0]?.kind).toBe("pulse");
  });

  it("a custom song keeps 10 channels and drops the rest with an error each", () => {
    const channels = Array.from({ length: 12 }, (_, i) => ({
      id: `c${i}`,
      instrument: null,
      kind: "pulse",
      mml: null,
      muted: false,
      pan: 0,
      volume: 1,
    }));
    const r = normalizeSong({ ...defaultSong("custom"), channels });
    expect(r.value.channels.map((c) => c.id)).toEqual(
      channels.slice(0, 10).map((c) => c.id)
    );
    has(r, "error", "/channels/10", /at most 10 channels, "c10" was dropped/);
    has(r, "error", "/channels/11", /"c11" was dropped/);
  });

  it("an order longer than 256 entries is cut with a warning", () => {
    const r = normalizeSong({
      ...nes(),
      order: new Array(300).fill("pattern-1"),
    });
    expect(r.value.order).toHaveLength(256);
    has(r, "warning", "/order", /at most 256 entries \(had 300\)/);
  });

  it("master echo and reverb on a chip without master effects are kept but warned about", () => {
    const echo = { delay: 0.2, feedback: 0.3, level: 0.3, lowpassHz: 4000 };
    const reverb = { damping: 0.5, level: 0.3, size: 0.5 };
    const onNes = normalizeSong({
      ...nes(),
      master: { echo, reverb, volume: 0.8 },
    });
    has(onNes, "warning", "/master/echo", /chip "nes" has no master effects/);
    has(onNes, "warning", "/master/reverb", /chip "nes" has no master effects/);
    const onSnes = normalizeSong({
      ...defaultSong("snes"),
      master: { echo, reverb, volume: 0.8 },
    });
    expect(onSnes.issues).toEqual([]);
    expect(onSnes.value.master).toEqual({ echo, reverb, volume: 0.8 });
  });

  it("an instrument designed for another chip is a warning, not an error", () => {
    const base = nes();
    const gb = { ...defaultInstrument("pulse"), chip: "gameboy" as const };
    const r = normalizeSong(
      {
        ...base,
        channels: base.channels.map((c, i) =>
          i === 0 ? { ...c, instrument: "x" } : c
        ),
      },
      { x: gb }
    );
    expect(r.ok).toBe(true);
    has(
      r,
      "warning",
      "/channels/0/instrument",
      /designed for chip "gameboy", this song uses "nes"/
    );
  });

  it("a 4 operator fm instrument with no chip on a 2 operator chip warns that operators 0 and 1 play", () => {
    const base = defaultSong("adlib");
    const four = { ...defaultInstrument("fm"), chip: null };
    const r = normalizeSong(
      {
        ...base,
        channels: base.channels.map((c, i) =>
          i === 0 ? { ...c, instrument: "x" } : c
        ),
      },
      { x: four }
    );
    expect(r.ok).toBe(true);
    has(
      r,
      "warning",
      "/channels/0/instrument",
      /4 operators, chip "adlib" uses operators 0 and 1 with algorithm min\(algorithm, 1\)/
    );
  });
});

describe("patch details", () => {
  const table = () => {
    const t = new Array(32).fill(3);
    t[3] = 99;
    t[4] = -2;
    t[5] = 7.5;
    return t;
  };

  it("wavetable entries are whole numbers 0..15, in an sfx and in an instrument", () => {
    const sfx = normalizeSfx({
      ...defaultSfx(),
      chip: "gameboy",
      table: table(),
      wave: "wave",
    });
    const inst = normalizeInstrument({
      ...defaultInstrument("wave"),
      wave: { table: table() },
    });
    for (const [r, base, got] of [
      [sfx, "/table", sfx.value.table],
      [inst, "/wave/table", inst.value.wave?.table],
    ] as const) {
      has(r, "warning", `${base}/3`, /0 to 15 \(was 99\)/);
      has(r, "warning", `${base}/4`, /0 to 15 \(was -2\)/);
      has(r, "warning", `${base}/5`, /whole number \(was 7\.5\)/);
      expect(got?.slice(2, 7)).toEqual([3, 15, 0, 8, 3]);
      expect(r.ok).toBe(true);
    }
  });

  it("sid waveforms list 1 to 4 distinct known waveforms", () => {
    const sid = (waveforms: unknown) => ({
      ...defaultInstrument("sid"),
      sid: { ...defaultInstrument("sid").sid, waveforms },
    });
    const empty = normalizeInstrument(sid([]));
    has(empty, "error", "/sid/waveforms", /1 to 4 waveforms/);
    expect(empty.value.sid?.waveforms).toEqual(["pulse"]);
    const dup = normalizeInstrument(sid(["tri", "saw", "tri"]));
    has(dup, "warning", "/sid/waveforms/2", /"tri" is listed twice/);
    expect(dup.value.sid?.waveforms).toEqual(["tri", "saw"]);
    expect(dup.ok).toBe(true);
    const unknown = normalizeInstrument(sid(["zzz"]));
    has(
      unknown,
      "error",
      "/sid/waveforms/0",
      /must be one of tri, saw, pulse, noise/
    );
  });

  it("a macro keeps its first 256 values and warns about the rest", () => {
    const r = normalizeInstrument({
      ...defaultInstrument("pulse"),
      macros: {
        volume: { loop: -1, release: -1, values: new Array(300).fill(1) },
      },
    });
    expect(r.value.macros.volume?.values).toHaveLength(256);
    has(r, "warning", "/macros/volume/values", /1 to 256 entries \(had 300\)/);
  });

  it("an unknown kind or arpeggio mode is an error that falls back to a valid value", () => {
    const kind = normalizeInstrument({
      ...defaultInstrument("pulse"),
      kind: "bogus",
    });
    has(
      kind,
      "error",
      "/kind",
      /must be one of pulse, triangle, noise, wave, sid, fm, sample/
    );
    expect(kind.value.kind).toBe("pulse");
    const mode = normalizeInstrument({
      ...defaultInstrument("pulse"),
      macros: { arpeggioMode: "bad" },
    });
    has(mode, "error", "/macros/arpeggioMode", /offset, fixed/);
    expect(mode.value.macros.arpeggioMode).toBe("offset");
  });
});
