// biome-ignore-all assist/source/useSortedKeys: the key order of a document is part of its file format (version first, then name and the rest as written in the architecture)
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: audio hot paths and long effect switches stay in one function: no call overhead and the order reads like the signal flow
// biome-ignore-all lint/style/useDestructuring: per-sample loops copy fields into locals on purpose, destructuring adds nothing there
import { CHIPS } from "../chips/index.ts";
import { SAMPLE_SPECS } from "../samples/specs.ts";
import type {
  ChannelKind,
  ChipId,
  FmOperator,
  FmPatch,
  Instrument,
  Macro,
  Macros,
  Normalized,
  SamplePatch,
  SidPatch,
} from "../types.ts";
import {
  CHANNEL_KINDS,
  CHIP_IDS,
  FORMAT_VERSION,
  SAMPLE_GENERATOR_IDS,
} from "../types.ts";
import {
  defaultEnvelope,
  defaultFmOperator,
  defaultFmPatch,
  defaultInstrument,
  defaultSidPatch,
  defaultWaveTable,
} from "./defaults.ts";
import type { Ctx, Rec } from "./issues.ts";
import {
  boolField,
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

const INSTRUMENT_KEYS = [
  "id",
  "version",
  "name",
  "kind",
  "chip",
  "volume",
  "pan",
  "transpose",
  "finetune",
  "envelope",
  "macros",
  "send",
  "pulse",
  "wave",
  "noise",
  "sid",
  "fm",
  "sample",
];
const MACRO_KEYS = [
  "volume",
  "arpeggio",
  "arpeggioMode",
  "pitch",
  "duty",
  "pan",
];
const MACRO_FIELDS = ["values", "loop", "release"];
const SID_WAVES = ["tri", "saw", "pulse", "noise"] as const;
const SID_MODES = ["off", "lp", "bp", "hp"] as const;
const OP_KEYS = [
  "mult",
  "detune",
  "level",
  "attack",
  "decay",
  "sustainLevel",
  "sustainRate",
  "release",
  "keyScale",
  "waveform",
  "fixedHz",
];

interface MacroRange {
  def: number;
  int: boolean;
  max: number;
  min: number;
}

/** Read one macro. Absent (undefined or null) gives undefined; a broken macro is reported and dropped. */
function readMacro(
  ctx: Ctx,
  v: unknown,
  path: string,
  range: MacroRange
): Macro | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  if (!isRec(v)) {
    error(
      ctx,
      path,
      `must be an object with values, loop and release (was ${show(v)})`
    );
    return undefined;
  }
  dropUnknown(ctx, v, path, MACRO_FIELDS);
  const raw = v.values;
  if (!Array.isArray(raw)) {
    error(
      ctx,
      ptr(path, "values"),
      raw === undefined
        ? "is required"
        : `must be an array of numbers (was ${show(raw)})`
    );
    return undefined;
  }
  if (raw.length === 0) {
    error(ctx, ptr(path, "values"), "must have 1 to 256 entries (had 0)");
    return undefined;
  }
  let list: unknown[] = raw;
  if (list.length > 256) {
    warn(
      ctx,
      ptr(path, "values"),
      `must have 1 to 256 entries (had ${list.length}), extra entries were dropped`
    );
    list = list.slice(0, 256);
  }
  const values: number[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const x = list[i];
    const p = ptr(ptr(path, "values"), i);
    if (typeof x !== "number" || !Number.isFinite(x)) {
      error(ctx, p, `must be a number (was ${show(x)})`);
      values.push(range.def);
    } else {
      values.push(clampNum(ctx, x, p, range));
    }
  }
  const last = values.length - 1;
  const loop = numField(ctx, v, "loop", path, {
    min: -1,
    max: last,
    int: true,
    def: -1,
  });
  const release = numField(ctx, v, "release", path, {
    min: -1,
    max: last,
    int: true,
    def: -1,
  });
  return { values, loop, release };
}

function readMacros(ctx: Ctx, doc: Rec, kind: ChannelKind): Macros {
  const m = section(ctx, doc, "macros", "");
  dropUnknown(ctx, m, "/macros", MACRO_KEYS);
  const out: Macros = {};
  const mode = enumField(
    ctx,
    m,
    "arpeggioMode",
    "/macros",
    ["offset", "fixed"] as const,
    "offset"
  );
  const vol = readMacro(ctx, m.volume, "/macros/volume", {
    min: 0,
    max: 1,
    int: false,
    def: 1,
  });
  if (vol) {
    out.volume = vol;
  }
  const arpRange: MacroRange =
    mode === "fixed"
      ? { min: 0, max: 127, int: true, def: 0 }
      : { min: -96, max: 96, int: true, def: 0 };
  const arp = readMacro(ctx, m.arpeggio, "/macros/arpeggio", arpRange);
  if (arp) {
    out.arpeggio = arp;
  }
  if (arp || m.arpeggioMode !== undefined) {
    out.arpeggioMode = mode;
  }
  const pitch = readMacro(ctx, m.pitch, "/macros/pitch", {
    min: -1200,
    max: 1200,
    int: false,
    def: 0,
  });
  if (pitch) {
    out.pitch = pitch;
  }
  const duty = readMacro(ctx, m.duty, "/macros/duty", {
    min: 0,
    max: 255,
    int: true,
    def: 0,
  });
  if (duty) {
    out.duty = duty;
    if (kind === "wave" && duty.values.some((x) => x !== 0)) {
      warn(
        ctx,
        "/macros/duty",
        'values other than 0 are ignored for kind "wave" (one wavetable per instrument)'
      );
    }
  }
  const pan = readMacro(ctx, m.pan, "/macros/pan", {
    min: -1,
    max: 1,
    int: false,
    def: 0,
  });
  if (pan) {
    out.pan = pan;
  }
  return out;
}

function readTable(ctx: Ctx, v: unknown, path: string): number[] {
  if (v === undefined) {
    return defaultWaveTable();
  }
  if (!Array.isArray(v)) {
    error(
      ctx,
      path,
      `must be an array of 32 integers 0 to 15 (was ${show(v)})`
    );
    return defaultWaveTable();
  }
  if (v.length !== 32) {
    error(ctx, path, `must have exactly 32 entries (had ${v.length})`);
    return defaultWaveTable();
  }
  const out: number[] = [];
  for (let i = 0; i < 32; i += 1) {
    const x = v[i];
    if (typeof x !== "number" || !Number.isFinite(x)) {
      error(ctx, ptr(path, i), `must be a number (was ${show(x)})`);
      out.push(0);
    } else {
      out.push(clampNum(ctx, x, ptr(path, i), { min: 0, max: 15, int: true }));
    }
  }
  return out;
}

function readSid(ctx: Ctx, v: unknown): SidPatch {
  const def = defaultSidPatch();
  const p = "/sid";
  const s = isRec(v) ? v : {};
  if (v !== undefined && !isRec(v)) {
    error(ctx, p, `must be an object (was ${show(v)})`);
  }
  dropUnknown(ctx, s, p, [
    "waveforms",
    "pulseWidth",
    "pwmRate",
    "pwmDepth",
    "ring",
    "sync",
    "filter",
  ]);
  let waveforms: SidPatch["waveforms"] = def.waveforms;
  const raw = s.waveforms;
  if (raw !== undefined) {
    if (Array.isArray(raw)) {
      const list: SidPatch["waveforms"] = [];
      for (let i = 0; i < raw.length; i += 1) {
        const w = SID_WAVES.find((x) => x === raw[i]);
        if (w === undefined) {
          error(
            ctx,
            ptr(ptr(p, "waveforms"), i),
            `must be one of ${SID_WAVES.join(", ")} (was ${show(raw[i])})`
          );
        } else if (list.includes(w)) {
          warn(
            ctx,
            ptr(ptr(p, "waveforms"), i),
            `"${w}" is listed twice, the duplicate was dropped`
          );
        } else {
          list.push(w);
        }
      }
      if (list.length === 0) {
        error(ctx, ptr(p, "waveforms"), "must list 1 to 4 waveforms");
      } else {
        waveforms = list;
      }
    } else {
      error(
        ctx,
        ptr(p, "waveforms"),
        `must be an array of waveforms (was ${show(raw)})`
      );
    }
  }
  const f = section(ctx, s, "filter", p);
  dropUnknown(ctx, f, "/sid/filter", ["mode", "cutoff", "resonance", "sweep"]);
  return {
    waveforms,
    pulseWidth: numField(ctx, s, "pulseWidth", p, {
      min: 0,
      max: 1,
      def: def.pulseWidth,
    }),
    pwmRate: numField(ctx, s, "pwmRate", p, {
      min: 0,
      max: 20,
      def: def.pwmRate,
    }),
    pwmDepth: numField(ctx, s, "pwmDepth", p, {
      min: 0,
      max: 1,
      def: def.pwmDepth,
    }),
    ring: boolField(ctx, s, "ring", p, def.ring),
    sync: boolField(ctx, s, "sync", p, def.sync),
    filter: {
      mode: enumField(ctx, f, "mode", "/sid/filter", SID_MODES, "off"),
      cutoff: numField(ctx, f, "cutoff", "/sid/filter", {
        min: 0,
        max: 1,
        def: def.filter.cutoff,
      }),
      resonance: numField(ctx, f, "resonance", "/sid/filter", {
        min: 0,
        max: 1,
        def: def.filter.resonance,
      }),
      sweep: numField(ctx, f, "sweep", "/sid/filter", {
        min: -0.05,
        max: 0.05,
        def: 0,
      }),
    },
  };
}

function readOperator(ctx: Ctx, v: unknown, path: string): FmOperator {
  const def = defaultFmOperator();
  const o = isRec(v) ? v : {};
  if (!isRec(v)) {
    error(ctx, path, `must be an object (was ${show(v)})`);
  }
  dropUnknown(ctx, o, path, OP_KEYS);
  return {
    mult: numField(ctx, o, "mult", path, {
      min: 0,
      max: 15,
      int: true,
      def: def.mult,
    }),
    detune: numField(ctx, o, "detune", path, {
      min: -3,
      max: 3,
      int: true,
      def: def.detune,
    }),
    level: numField(ctx, o, "level", path, { min: 0, max: 1, def: def.level }),
    attack: numField(ctx, o, "attack", path, {
      min: 0,
      max: 31,
      int: true,
      def: def.attack,
    }),
    decay: numField(ctx, o, "decay", path, {
      min: 0,
      max: 31,
      int: true,
      def: def.decay,
    }),
    sustainLevel: numField(ctx, o, "sustainLevel", path, {
      min: 0,
      max: 1,
      def: def.sustainLevel,
    }),
    sustainRate: numField(ctx, o, "sustainRate", path, {
      min: 0,
      max: 31,
      int: true,
      def: def.sustainRate,
    }),
    release: numField(ctx, o, "release", path, {
      min: 0,
      max: 15,
      int: true,
      def: def.release,
    }),
    keyScale: numField(ctx, o, "keyScale", path, {
      min: 0,
      max: 3,
      int: true,
      def: def.keyScale,
    }),
    waveform: numField(ctx, o, "waveform", path, {
      min: 0,
      max: 7,
      int: true,
      def: def.waveform,
    }),
    fixedHz: nullableNumField(ctx, o, "fixedHz", path, {
      min: 1,
      max: 20_000,
      def: null,
    }),
  };
}

function chipFmOps(chip: ChipId | null): 2 | 4 | null {
  if (chip === null || chip === "custom") {
    return null;
  }
  return CHIPS[chip].channels.find((c) => c.kind === "fm")?.fmOps ?? null;
}

function readFm(ctx: Ctx, v: unknown, chip: ChipId | null): FmPatch {
  const p = "/fm";
  const wantOps = chipFmOps(chip) ?? 4;
  if (v === undefined) {
    return defaultFmPatch(wantOps);
  }
  if (!isRec(v)) {
    error(ctx, p, `must be an object (was ${show(v)})`);
    return defaultFmPatch(wantOps);
  }
  dropUnknown(ctx, v, p, ["algorithm", "feedback", "ops", "lfo"]);
  let ops: FmOperator[];
  const raw = v.ops;
  if (raw === undefined) {
    ops = defaultFmPatch(wantOps).ops;
  } else if (!Array.isArray(raw) || (raw.length !== 2 && raw.length !== 4)) {
    error(
      ctx,
      ptr(p, "ops"),
      `must have 2 or 4 operators (was ${Array.isArray(raw) ? raw.length : show(raw)})`
    );
    ops = defaultFmPatch(wantOps).ops;
  } else {
    ops = raw.map((o, i) => readOperator(ctx, o, ptr(ptr(p, "ops"), i)));
  }
  const needed = chipFmOps(chip);
  if (needed !== null && ops.length !== needed) {
    error(
      ctx,
      ptr(p, "ops"),
      `must have ${needed} operators for chip "${chip}" (had ${ops.length})`
    );
  }
  const algMax = ops.length === 4 ? 7 : 1;
  let lfo: FmPatch["lfo"] = null;
  if (v.lfo !== undefined && v.lfo !== null) {
    if (isRec(v.lfo)) {
      dropUnknown(ctx, v.lfo, "/fm/lfo", ["rate", "pitchDepth", "ampDepth"]);
      lfo = {
        rate: numField(ctx, v.lfo, "rate", "/fm/lfo", {
          min: 0,
          max: 20,
          def: 5,
        }),
        pitchDepth: numField(ctx, v.lfo, "pitchDepth", "/fm/lfo", {
          min: 0,
          max: 100,
          def: 0,
        }),
        ampDepth: numField(ctx, v.lfo, "ampDepth", "/fm/lfo", {
          min: 0,
          max: 1,
          def: 0,
        }),
      };
    } else {
      error(ctx, "/fm/lfo", `must be an object or null (was ${show(v.lfo)})`);
    }
  }
  return {
    algorithm: numField(ctx, v, "algorithm", p, {
      min: 0,
      max: algMax,
      int: true,
      def: 0,
    }),
    feedback: numField(ctx, v, "feedback", p, {
      min: 0,
      max: 7,
      int: true,
      def: 0,
    }),
    ops,
    lfo,
  };
}

function readSample(ctx: Ctx, v: unknown): SamplePatch {
  const p = "/sample";
  const s = isRec(v) ? v : {};
  if (v !== undefined && !isRec(v)) {
    error(ctx, p, `must be an object (was ${show(v)})`);
  }
  dropUnknown(ctx, s, p, ["generator", "params", "seed", "baseNote", "loop"]);
  const generator = enumField(
    ctx,
    s,
    "generator",
    p,
    SAMPLE_GENERATOR_IDS,
    "pluck",
    true
  );
  const spec = SAMPLE_SPECS[generator];
  const rawParams = s.params;
  const given = isRec(rawParams) ? rawParams : {};
  if (rawParams !== undefined && !isRec(rawParams)) {
    error(
      ctx,
      ptr(p, "params"),
      `must be an object of numbers (was ${show(rawParams)})`
    );
  }
  dropUnknown(ctx, given, "/sample/params", Object.keys(spec.params));
  const params: Record<string, number> = {};
  for (const [key, ps] of Object.entries(spec.params)) {
    params[key] = numField(ctx, given, key, "/sample/params", {
      min: ps.min,
      max: ps.max,
      def: ps.default,
    });
  }
  const loop = boolField(ctx, s, "loop", p, false);
  if (loop && !spec.loops) {
    warn(
      ctx,
      ptr(p, "loop"),
      `generator "${generator}" does not loop, loop was ignored`
    );
  }
  return {
    generator,
    params,
    seed: numField(ctx, s, "seed", p, {
      min: 0,
      max: 4_294_967_295,
      int: true,
      def: 1,
    }),
    baseNote: numField(ctx, s, "baseNote", p, {
      min: 0,
      max: 127,
      int: true,
      def: 60,
    }),
    loop,
  };
}

/** Warn when a block that does not belong to the kind holds data. */
function ignoredBlock(
  ctx: Ctx,
  doc: Rec,
  key: string,
  kind: ChannelKind
): void {
  const v = doc[key];
  if (v !== undefined && v !== null) {
    warn(
      ctx,
      ptr("", key),
      `is ignored for kind "${kind}" and was set to null`
    );
  }
}

export function normalizeInstrument(input: unknown): Normalized<Instrument> {
  const ctx = newCtx();
  if (!isRec(input)) {
    error(ctx, "", `must be an object (was ${show(input)})`);
    return finish(ctx, defaultInstrument("pulse"));
  }
  const from = readVersion(ctx, input, FORMAT_VERSION);
  const doc = migrate(input, from);
  dropUnknown(ctx, doc, "", INSTRUMENT_KEYS);
  const id = readId(ctx, doc);

  const kind = enumField(ctx, doc, "kind", "", CHANNEL_KINDS, "pulse", true);
  let chip: ChipId | null = null;
  if (doc.chip !== undefined && doc.chip !== null) {
    chip = enumField(ctx, doc, "chip", "", CHIP_IDS, "custom");
    if (!CHIP_IDS.includes(chip) || doc.chip !== chip) {
      chip = null;
    }
  }
  if (chip !== null && !CHIPS[chip].kinds.includes(kind)) {
    error(
      ctx,
      "/kind",
      `kind "${kind}" is not available on chip "${chip}" (it hosts ${CHIPS[chip].kinds.join(", ")})`
    );
  }

  const env = section(ctx, doc, "envelope", "");
  dropUnknown(ctx, env, "/envelope", ["attack", "decay", "sustain", "release"]);
  const denv = defaultEnvelope();
  const send = section(ctx, doc, "send", "");
  dropUnknown(ctx, send, "/send", ["echo", "reverb"]);

  const value: Instrument = {
    version: FORMAT_VERSION,
    name: strField(ctx, doc, "name", "", "Untitled"),
    kind,
    chip,
    volume: numField(ctx, doc, "volume", "", { min: 0, max: 1, def: 0.8 }),
    pan: numField(ctx, doc, "pan", "", { min: -1, max: 1, def: 0 }),
    transpose: numField(ctx, doc, "transpose", "", {
      min: -48,
      max: 48,
      def: 0,
    }),
    finetune: numField(ctx, doc, "finetune", "", {
      min: -100,
      max: 100,
      def: 0,
    }),
    envelope: {
      attack: numField(ctx, env, "attack", "/envelope", {
        min: 0,
        max: 4,
        def: denv.attack,
      }),
      decay: numField(ctx, env, "decay", "/envelope", {
        min: 0,
        max: 4,
        def: denv.decay,
      }),
      sustain: numField(ctx, env, "sustain", "/envelope", {
        min: 0,
        max: 1,
        def: denv.sustain,
      }),
      release: numField(ctx, env, "release", "/envelope", {
        min: 0,
        max: 8,
        def: denv.release,
      }),
    },
    macros: readMacros(ctx, doc, kind),
    send: {
      echo: numField(ctx, send, "echo", "/send", { min: 0, max: 1, def: 0 }),
      reverb: numField(ctx, send, "reverb", "/send", {
        min: 0,
        max: 1,
        def: 0,
      }),
    },
    pulse: null,
    wave: null,
    noise: null,
    sid: null,
    fm: null,
    sample: null,
  };

  const blocks: ChannelKind[] = [
    "pulse",
    "wave",
    "noise",
    "sid",
    "fm",
    "sample",
  ];
  for (const b of blocks) {
    if (b !== kind) {
      ignoredBlock(ctx, doc, b, kind);
    }
  }
  if (kind === "pulse") {
    const s = section(ctx, doc, "pulse", "");
    dropUnknown(ctx, s, "/pulse", ["duty"]);
    value.pulse = {
      duty: numField(ctx, s, "duty", "/pulse", { min: 0, max: 1, def: 0.5 }),
    };
  } else if (kind === "wave") {
    const s = section(ctx, doc, "wave", "");
    dropUnknown(ctx, s, "/wave", ["table"]);
    value.wave = { table: readTable(ctx, s.table, "/wave/table") };
  } else if (kind === "noise") {
    const s = section(ctx, doc, "noise", "");
    dropUnknown(ctx, s, "/noise", ["mode"]);
    value.noise = {
      mode: enumField(
        ctx,
        s,
        "mode",
        "/noise",
        ["long", "short"] as const,
        "long"
      ),
    };
  } else if (kind === "sid") {
    value.sid = readSid(ctx, doc.sid);
  } else if (kind === "fm") {
    value.fm = readFm(ctx, doc.fm, chip);
  } else if (kind === "sample") {
    value.sample = readSample(ctx, doc.sample);
  }
  if (id !== undefined) {
    (value as Instrument & { id?: string }).id = id;
  }
  return finish(ctx, value);
}
