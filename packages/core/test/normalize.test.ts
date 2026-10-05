import { describe, expect, it } from "vitest";
import type { Instrument, Issue, Normalized, Row, Song } from "../src/index.ts";
import {
  defaultInstrument,
  defaultProject,
  defaultSfx,
  defaultSong,
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
import { fixtureJson } from "./helpers.ts";

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
  it("fills defaults silently", () => {
    const r = normalizeProject({ version: 1 });
    expect(r.issues).toEqual([]);
    expect(r.value).toEqual(defaultProject());
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
    expect(r.value.master.volume).toBe(1);
    expect(r.value.sampleRate).toBe(48_000);
    expect(r.value.chip).toBe("nes");
    expect(r.value.export.oggQuality).toBe(10);
  });

  it("accepts the example project from the contract with no issues", () => {
    const r = normalizeProject(fixtureJson("project.json"));
    expect(r.issues).toEqual([]);
    expect(r.value.chip).toBe("genesis");
    expect(r.value.sampleRate).toBe(48_000);
  });
});

describe("sfx", () => {
  it.each([
    ["nes", "fm"],
    ["nes", "saw"],
    ["gameboy", "fm"],
    ["c64", "fm"],
    ["genesis", "triangle"],
    ["adlib", "noise"],
    ["snes", "wave"],
  ] as const)(
    "wave %s on %s is replaced by the chip's first allowed wave",
    (chip, wave) => {
      const r = normalizeSfx({
        ...defaultSfx(),
        chip,
        fm: { index: 2, indexDecay: 0.3, ratio: 2 },
        table: new Array(32).fill(3),
        wave,
      });
      has(r, "error", "/wave", /not available/);
      expect(r.ok).toBe(false);
      expect(["square", "fm", "sine"]).toContain(r.value.wave);
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

  it("clamps ranges with a warning that names the incoming value", () => {
    const r = normalizeSfx({
      ...defaultSfx(),
      frequency: { deltaSlide: 99, min: 0, slide: 0, start: 1 },
      volume: 4,
    });
    has(r, "warning", "/volume", /was 4/);
    has(r, "warning", "/frequency/start", /20 to 8000/);
    has(r, "warning", "/frequency/deltaSlide");
    expect(r.value.frequency.start).toBe(20);
  });

  it("limits the arpeggio to 8 steps in range", () => {
    const r = normalizeSfx({
      ...defaultSfx(),
      arpeggio: { rate: 10, steps: [1, 2, 3, 4, 5, 6, 7, 8, 9, 99] },
    });
    expect(r.value.arpeggio.steps.length).toBeLessThanOrEqual(8);
    expect(r.value.arpeggio.steps.every((s) => Math.abs(s) <= 24)).toBe(true);
    expect(r.issues.length).toBeGreaterThan(0);
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

  it("fills a default block when kind needs one and it is absent", () => {
    const base = Object.fromEntries(
      Object.entries(defaultInstrument("sid")).filter(([k]) => k !== "sid")
    ) as Partial<Instrument>;
    const r = normalizeInstrument(base);
    expect(r.value.sid).not.toBeNull();
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
  it.each([
    ["047", { type: "arp", x: 4, y: 7 }],
    ["A0F", { type: "volSlide", x: 0, y: 15 }],
    ["130", { type: "slideUp", x: 3, y: 0 }],
    ["B02", { type: "jump", x: 0, y: 2 }],
    ["FF0", { type: "tempo", x: 15, y: 0 }],
    ["V03", { type: "duty", x: 0, y: 3 }],
    ["X80", { type: "pan", x: 8, y: 0 }],
  ] as const)(
    "string %s parses to the typed form and formats back",
    (code, typed) => {
      const parsed = parseEffect(code);
      expect(parsed).toMatchObject(typed);
      if (parsed) {
        expect(formatEffect(parsed)).toBe(code);
      }
    }
  );

  it("round trips every effect type through format and parse", () => {
    const types = [
      "arp",
      "slideUp",
      "slideDown",
      "portamento",
      "vibrato",
      "tremolo",
      "volSlide",
      "jump",
      "halt",
      "skip",
      "tempo",
      "duty",
      "pitch",
      "cut",
      "delay",
      "noteSlideUp",
      "noteSlideDown",
      "pan",
      "send",
      "retrigger",
    ] as const;
    for (const type of types) {
      const e = { type, x: 3, y: 9 };
      const text = formatEffect(e);
      expect(text).toMatch(/^[0-9A-Z][0-9A-F]{2}$/);
      expect(parseEffect(text)).toEqual(e);
    }
  });

  it("rejects malformed effect codes", () => {
    for (const bad of ["", "zzz", "A0", "A0FF", "900", "A0G"]) {
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

  it("formatRowString round trips parseRowString", () => {
    for (const s of [
      "C-4 lead vF A0F",
      "OFF",
      "E-5 . . 047",
      "G-5 . vC",
      "C-2 bass",
    ]) {
      const { row, issues } = parseRowString(s, 0);
      expect(issues.filter((i) => i.severity === "error")).toEqual([]);
      const again = parseRowString(formatRowString(row), 0);
      expect(again.row).toEqual(row);
    }
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
    expect(high.issues.some((i) => i.severity === "warning")).toBe(true);
    for (const bad of ["H-9", "banana", {}, true]) {
      const r = withNote(bad);
      expect(
        r.issues.some((i) => i.severity === "error"),
        `a note of ${JSON.stringify(bad)} should be an error`
      ).toBe(true);
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
    expect(r.value.patterns.a?.tracks.pulse1?.map((x) => x.row)).toEqual([
      1, 3,
    ]);
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

  it("clamps volume and tempo with warnings and limits fx to four per row", () => {
    const r = normalizeSong({
      ...nes(),
      patterns: {
        "pattern-1": {
          length: 8,
          tracks: {
            pulse1: [
              {
                fx: ["047", "047", "047", "047", "047"],
                inst: null,
                note: 60,
                row: 0,
                vol: 99,
              },
            ],
          },
        },
      },
      tempo: 900,
    });
    has(r, "warning", "/tempo", /20 to 400/);
    has(r, "warning", "/patterns/pattern-1/tracks/pulse1/0/vol");
    expect(r.value.patterns["pattern-1"]?.tracks.pulse1?.[0]?.fx).toHaveLength(
      4
    );
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

  it("an all MML song with no patterns gets synthesized patterns, tempo and loop from the MML", () => {
    const base = nes();
    const r = normalizeSong({
      ...base,
      channels: base.channels.map((c, i) =>
        i === 0 ? { ...c, mml: "t140 l8 c d e f L g a b > c" } : c
      ),
      order: [],
      patterns: {},
    });
    expect(r.ok).toBe(true);
    expect(r.value.tempo).toBe(140);
    expect(r.value.order.length).toBeGreaterThan(0);
    expect(Object.keys(r.value.patterns)).toEqual(
      r.value.order.filter((v, i, a) => a.indexOf(v) === i)
    );
    expect(r.value.loop).not.toBeNull();
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

    it("says nothing when the document already agrees with L", () => {
      const where = song(MML, null).value.loop;
      const r = song(MML, where);
      expect(overrides(r)).toEqual([]);
      expect(r.value.loop).toBe(where);
    });

    it("warns, once, when the document names a different loop and takes L", () => {
      const where = song(MML, null).value.loop ?? 0;
      expect(where).toBeGreaterThan(0);
      const r = song(MML, 0);
      expect(overrides(r)).toHaveLength(1);
      has(
        r,
        "warning",
        "/loop",
        /overrides loop 0, the song loops to order \d/
      );
      expect(r.value.loop).toBe(where);
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

  it("accepts the title song with its instruments and round trips", () => {
    const first = normalizeSong(fixtureJson("song-title.json"));
    expect(first.issues).toEqual([]);
    const second = normalizeSong(first.value);
    expect(second.issues).toEqual([]);
    expect(second.value).toEqual(first.value);
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
    }
  });
});
