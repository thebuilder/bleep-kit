import { CHIPS, chipSfxWaves } from "../chips/index.ts";
import { nearest } from "../nearest.ts";
import type {
  ChipId,
  Normalized,
  Sfx,
  SfxCategory,
  SfxWave,
} from "../types.ts";
import {
  CHIP_IDS,
  FORMAT_VERSION,
  SFX_CATEGORIES,
  SFX_WAVES,
} from "../types.ts";
import { defaultSfx, defaultWaveTable } from "./defaults.ts";
import type { Ctx, Rec } from "./issues.ts";
import {
  clampNum,
  dropUnknown,
  enumField,
  error,
  finish,
  isRec,
  newCtx,
  nullableNumField,
  numField,
  ptr,
  readId,
  readVersion,
  section,
  show,
  strField,
  warn,
} from "./issues.ts";
import { migrate } from "./migrate.ts";

const SFX_KEYS = [
  "id",
  "version",
  "name",
  "category",
  "chip",
  "seed",
  "wave",
  "volume",
  "frequency",
  "vibrato",
  "arpeggio",
  "envelope",
  "duty",
  "repeat",
  "phaser",
  "filter",
  "bitcrush",
  "noise",
  "fm",
  "table",
];
const MAX_TOTAL_SECONDS = 10;

/** The first `list.length` entries as integers in min..max: anything that is not a number is an error and becomes 0. */
function readInts(
  ctx: Ctx,
  list: readonly unknown[],
  p: string,
  min: number,
  max: number
): number[] {
  const out: number[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const s = list[i];
    if (typeof s !== "number" || !Number.isFinite(s)) {
      error(ctx, ptr(p, i), `must be a number (was ${show(s)})`);
      out.push(0);
    } else {
      out.push(clampNum(ctx, s, ptr(p, i), { min, max, int: true }));
    }
  }
  return out;
}

function readSteps(ctx: Ctx, arp: Rec): number[] {
  const v = arp.steps;
  const p = "/arpeggio/steps";
  if (v === undefined) {
    return [];
  }
  if (!Array.isArray(v)) {
    error(ctx, p, `must be an array of semitone steps (was ${show(v)})`);
    return [];
  }
  let list: unknown[] = v;
  if (list.length > 8) {
    warn(
      ctx,
      p,
      `must have at most 8 steps (had ${list.length}), extra steps were dropped`
    );
    list = list.slice(0, 8);
  }
  return readInts(ctx, list, p, -24, 24);
}

function readTable(ctx: Ctx, v: unknown, required: boolean): number[] | null {
  const p = "/table";
  if (v === undefined || v === null) {
    if (required) {
      error(ctx, p, 'is required when wave is "wave"');
      return defaultWaveTable();
    }
    return null;
  }
  if (!Array.isArray(v)) {
    error(ctx, p, `must be an array of 32 integers 0 to 15 (was ${show(v)})`);
    return required ? defaultWaveTable() : null;
  }
  if (v.length !== 32) {
    error(ctx, p, `must have exactly 32 entries (had ${v.length})`);
    return required ? defaultWaveTable() : null;
  }
  return readInts(ctx, v, p, 0, 15);
}

function readFm(ctx: Ctx, v: unknown, required: boolean): Sfx["fm"] {
  const p = "/fm";
  const fallback = { ratio: 2, index: 2, indexDecay: 0.3 };
  if (v === undefined || v === null) {
    if (required) {
      error(ctx, p, 'is required when wave is "fm"');
      return fallback;
    }
    return null;
  }
  if (!isRec(v)) {
    error(ctx, p, `must be an object (was ${show(v)})`);
    return required ? fallback : null;
  }
  dropUnknown(ctx, v, p, ["ratio", "index", "indexDecay"]);
  return {
    ratio: numField(ctx, v, "ratio", p, {
      min: 0.5,
      max: 12,
      def: fallback.ratio,
    }),
    index: numField(ctx, v, "index", p, {
      min: 0,
      max: 8,
      def: fallback.index,
    }),
    indexDecay: numField(ctx, v, "indexDecay", p, {
      min: 0,
      max: 2,
      def: fallback.indexDecay,
    }),
  };
}

/** The sfx wave the chip will actually use: a disallowed wave falls back to the chip's first allowed wave (error). */
function readWave(ctx: Ctx, doc: Rec, chip: ChipId, def: SfxWave): SfxWave {
  const allowed = chipSfxWaves(chip);
  const fallback = allowed[0] ?? def;
  const wave = enumField(ctx, doc, "wave", "", SFX_WAVES, fallback);
  if (!allowed.includes(wave)) {
    error(
      ctx,
      "/wave",
      `"${wave}" is not available on chip "${chip}" (allowed: ${allowed.join(", ")})`
    );
    return fallback;
  }
  return wave;
}

export function normalizeSfx(input: unknown): Normalized<Sfx> {
  const ctx = newCtx();
  if (!isRec(input)) {
    error(ctx, "", `must be an object (was ${show(input)})`);
    return finish(ctx, defaultSfx());
  }
  const from = readVersion(ctx, input, FORMAT_VERSION);
  const doc = migrate(input, from);
  dropUnknown(ctx, doc, "", SFX_KEYS);
  const id = readId(ctx, doc);

  const chip = enumField(ctx, doc, "chip", "", CHIP_IDS, "nes");
  const def = defaultSfx(chip);
  const wave = readWave(ctx, doc, chip, def.wave);

  const fr = section(ctx, doc, "frequency", "");
  dropUnknown(ctx, fr, "/frequency", ["start", "min", "slide", "deltaSlide"]);
  const frequency = {
    start: numField(ctx, fr, "start", "/frequency", {
      min: 20,
      max: 8000,
      def: 440,
    }),
    min: numField(ctx, fr, "min", "/frequency", { min: 0, max: 8000, def: 0 }),
    slide: numField(ctx, fr, "slide", "/frequency", {
      min: -8,
      max: 8,
      def: 0,
    }),
    deltaSlide: numField(ctx, fr, "deltaSlide", "/frequency", {
      min: -16,
      max: 16,
      def: 0,
    }),
  };
  if (frequency.min > frequency.start && frequency.slide >= 0) {
    warn(
      ctx,
      "/frequency/min",
      `is ${frequency.min} Hz, above the start frequency ${frequency.start} Hz with no downward slide, so the sound stops immediately`
    );
  }

  const vib = section(ctx, doc, "vibrato", "");
  dropUnknown(ctx, vib, "/vibrato", ["depth", "rate"]);
  const arp = section(ctx, doc, "arpeggio", "");
  dropUnknown(ctx, arp, "/arpeggio", ["steps", "rate"]);
  const env = section(ctx, doc, "envelope", "");
  dropUnknown(ctx, env, "/envelope", ["attack", "sustain", "punch", "decay"]);
  const duty = section(ctx, doc, "duty", "");
  dropUnknown(ctx, duty, "/duty", ["start", "sweep"]);
  const rep = section(ctx, doc, "repeat", "");
  dropUnknown(ctx, rep, "/repeat", ["rate"]);
  const pha = section(ctx, doc, "phaser", "");
  dropUnknown(ctx, pha, "/phaser", ["offset", "sweep"]);
  const fil = section(ctx, doc, "filter", "");
  dropUnknown(ctx, fil, "/filter", [
    "lowpass",
    "lowpassSweep",
    "resonance",
    "highpass",
    "highpassSweep",
  ]);
  const crush = section(ctx, doc, "bitcrush", "");
  dropUnknown(ctx, crush, "/bitcrush", ["bits", "rateDivide"]);
  const noise = section(ctx, doc, "noise", "");
  dropUnknown(ctx, noise, "/noise", ["mode"]);

  const envelope = {
    attack: numField(ctx, env, "attack", "/envelope", {
      min: 0,
      max: 2,
      def: 0,
    }),
    sustain: numField(ctx, env, "sustain", "/envelope", {
      min: 0,
      max: 3,
      def: 0.1,
    }),
    punch: numField(ctx, env, "punch", "/envelope", { min: 0, max: 1, def: 0 }),
    decay: numField(ctx, env, "decay", "/envelope", {
      min: 0,
      max: 3,
      def: 0.2,
    }),
  };
  const rawTotal = ["attack", "sustain", "decay"].reduce((sum, k) => {
    const v = env[k];
    return (
      sum + (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0)
    );
  }, 0);
  if (rawTotal > MAX_TOTAL_SECONDS) {
    error(
      ctx,
      "/envelope",
      `attack + sustain + decay must be at most ${MAX_TOTAL_SECONDS} seconds (was ${rawTotal})`
    );
  }

  const dutyStart = numField(ctx, duty, "start", "/duty", {
    min: 0,
    max: 1,
    def: 0.5,
  });
  const dutyList = CHIPS[chip].constraints.dutyCycles;
  if (
    wave === "square" &&
    dutyList.length > 0 &&
    !dutyList.includes(dutyStart)
  ) {
    warn(
      ctx,
      "/duty/start",
      `duty ${dutyStart} is not available on chip "${chip}" and will snap to ${nearest(dutyList, dutyStart)}`
    );
  }

  const fm = readFm(ctx, doc.fm, wave === "fm");
  const table = readTable(ctx, doc.table, wave === "wave");
  if (wave !== "fm" && fm !== null) {
    warn(ctx, "/fm", 'is only used when wave is "fm" and was set to null');
  }
  if (wave !== "wave" && table !== null) {
    warn(ctx, "/table", 'is only used when wave is "wave" and was set to null');
  }

  const noiseMode = enumField(
    ctx,
    noise,
    "mode",
    "/noise",
    ["long", "short"] as const,
    "long"
  );

  const value: Sfx = {
    version: FORMAT_VERSION,
    name: strField(ctx, doc, "name", "", def.name),
    category: enumField(
      ctx,
      doc,
      "category",
      "",
      SFX_CATEGORIES,
      "custom" as SfxCategory
    ),
    chip,
    seed: numField(ctx, doc, "seed", "", {
      min: 0,
      max: 4_294_967_295,
      int: true,
      def: def.seed,
    }),
    wave,
    volume: numField(ctx, doc, "volume", "", { min: 0, max: 1, def: 0.7 }),
    frequency,
    vibrato: {
      depth: numField(ctx, vib, "depth", "/vibrato", {
        min: 0,
        max: 2,
        def: 0,
      }),
      rate: numField(ctx, vib, "rate", "/vibrato", { min: 0, max: 40, def: 0 }),
    },
    arpeggio: {
      steps: readSteps(ctx, arp),
      rate: numField(ctx, arp, "rate", "/arpeggio", {
        min: 0,
        max: 60,
        def: 0,
      }),
    },
    envelope,
    duty: {
      start: dutyStart,
      sweep: numField(ctx, duty, "sweep", "/duty", { min: -4, max: 4, def: 0 }),
    },
    repeat: {
      rate: numField(ctx, rep, "rate", "/repeat", { min: 0, max: 60, def: 0 }),
    },
    phaser: {
      offset: numField(ctx, pha, "offset", "/phaser", {
        min: -20,
        max: 20,
        def: 0,
      }),
      sweep: numField(ctx, pha, "sweep", "/phaser", {
        min: -40,
        max: 40,
        def: 0,
      }),
    },
    filter: {
      lowpass: nullableNumField(ctx, fil, "lowpass", "/filter", {
        min: 50,
        max: 20_000,
        def: null,
      }),
      lowpassSweep: numField(ctx, fil, "lowpassSweep", "/filter", {
        min: -8,
        max: 8,
        def: 0,
      }),
      resonance: numField(ctx, fil, "resonance", "/filter", {
        min: 0,
        max: 1,
        def: 0,
      }),
      highpass: nullableNumField(ctx, fil, "highpass", "/filter", {
        min: 20,
        max: 10_000,
        def: null,
      }),
      highpassSweep: numField(ctx, fil, "highpassSweep", "/filter", {
        min: -8,
        max: 8,
        def: 0,
      }),
    },
    bitcrush: {
      bits: nullableNumField(ctx, crush, "bits", "/bitcrush", {
        min: 1,
        max: 16,
        int: true,
        def: null,
      }),
      rateDivide: numField(ctx, crush, "rateDivide", "/bitcrush", {
        min: 1,
        max: 64,
        int: true,
        def: 1,
      }),
    },
    noise: { mode: noiseMode },
    fm: wave === "fm" ? fm : null,
    table: wave === "wave" ? table : null,
  };
  if (id !== undefined) {
    (value as Sfx & { id?: string }).id = id;
  }
  return finish(ctx, value);
}
