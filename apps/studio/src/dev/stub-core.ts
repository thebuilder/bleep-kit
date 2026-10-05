/* Stand-ins for the parts of @bleepkit/core and @bleepkit/sfx that other streams build, so the studio runs from day one.
   src/lib/core.ts prefers the real function whenever the package exports it; everything here is the fallback, small on
   purpose: it is good enough to draw views, play a rough preview through the fake engine and run the DOM tests. */
import {
  CHIP_IDS,
  type ChannelKind,
  type ChipChannel,
  type ChipId,
  type ChipProfile,
  type Effect,
  type EffectType,
  type EngineEvent,
  FORMAT_VERSION,
  type Instrument,
  type Issue,
  type MmlEvent,
  type Normalized,
  type Project,
  type RenderOptions,
  type RenderResult,
  type Row,
  type Sfx,
  type SfxCategory,
  type Song,
} from "../lib/contract.ts";

/* ---------- small helpers ---------- */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function merge<T>(base: T, input: unknown): T {
  if (!(isObj(input) && isObj(base))) {
    return clone(base);
  }
  const out: Record<string, unknown> = clone(base) as Record<string, unknown>;
  for (const [k, v] of Object.entries(input)) {
    if (!(k in out)) {
      continue;
    }
    const b = out[k];
    if (isObj(b) && isObj(v)) {
      out[k] = merge(b, v);
    } else if (Array.isArray(b) && Array.isArray(v)) {
      out[k] = clone(v);
    } else if (b === null || v === null || typeof b === typeof v) {
      out[k] = clone(v);
    }
  }
  return out as T;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d_2b_79_f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
export function hashString(s: string): number {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01_00_01_93);
  }
  return h >>> 0;
}

/* ---------- notes ---------- */

export const NOTE_NAMES = [
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
] as const;
export const noteToHz = (note: number, cents = 0): number =>
  440 * 2 ** ((note - 69 + cents / 100) / 12);
export const hzToNote = (hz: number): number => 69 + 12 * Math.log2(hz / 440);
export function noteName(note: number): string {
  const n = Math.round(note);
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}
export function parseNoteName(s: string): number | null {
  const m = /^([A-Ga-g])([-#+bB]?)(-?\d)$/.exec(s.trim());
  if (!m) {
    return null;
  }
  const base: Record<string, number> = {
    A: 9,
    B: 11,
    C: 0,
    D: 2,
    E: 4,
    F: 5,
    G: 7,
  };
  let n = base[(m[1] ?? "C").toUpperCase()] ?? 0;
  const acc = m[2] ?? "";
  if (acc === "#" || acc === "+") {
    n += 1;
  } else if (acc === "b" || acc === "B") {
    n -= 1;
  }
  return n + (Number(m[3]) + 1) * 12;
}

/* ---------- effects ---------- */

const FX_LETTER: Record<EffectType, string> = {
  arp: "0",
  cut: "S",
  delay: "G",
  duty: "V",
  halt: "C",
  jump: "B",
  noteSlideDown: "R",
  noteSlideUp: "Q",
  pan: "X",
  pitch: "P",
  portamento: "3",
  retrigger: "H",
  send: "W",
  skip: "D",
  slideDown: "2",
  slideUp: "1",
  tempo: "F",
  tremolo: "7",
  vibrato: "4",
  volSlide: "A",
};
export function formatEffect(e: Effect): string {
  const v = Math.max(0, Math.min(255, e.x * 16 + e.y));
  return `${FX_LETTER[e.type]}${v.toString(16).toUpperCase().padStart(2, "0")}`;
}
export function parseEffect(code: string): Effect | null {
  const m = /^([0-9A-Za-z])([0-9A-Fa-f]{2})$/.exec(code.trim());
  if (!m) {
    return null;
  }
  const letter = (m[1] ?? "").toUpperCase();
  const type = (Object.keys(FX_LETTER) as EffectType[]).find(
    (t) => FX_LETTER[t] === letter
  );
  if (!type) {
    return null;
  }
  const v = Number.parseInt(m[2] ?? "0", 16);
  return { type, x: v >> 4, y: v & 15 };
}

/* ---------- chips ---------- */

const ch = (
  id: string,
  kind: ChannelKind,
  label: string,
  extra: Partial<ChipChannel> = {}
): ChipChannel => ({
  id,
  kind,
  label,
  ...extra,
});
const numbered = (
  prefix: string,
  kind: ChannelKind,
  n: number,
  extra: Partial<ChipChannel> = {}
) =>
  Array.from({ length: n }, (_, i) =>
    ch(`${prefix}${i + 1}`, kind, `${prefix.toUpperCase()} ${i + 1}`, extra)
  );
const DUTIES = [0.125, 0.25, 0.5, 0.75];
const NO_COLOR = {
  bits: null,
  dac: "linear",
  gaussian: false,
  highpassHz: null,
  lowpassHz: null,
  sampleRate: null,
} as const;
const base = (
  id: ChipId,
  label: string,
  channels: ChipChannel[],
  kinds: ChannelKind[],
  c: Partial<ChipProfile["constraints"]>
): ChipProfile => ({
  channels,
  color: NO_COLOR,
  constraints: {
    clockHz: 1_789_773,
    dutyCycles: DUTIES,
    filter: false,
    masterFx: false,
    noise: "lfsr7-15",
    pan: "none",
    pitch: "period",
    triangleSteps: 0,
    volumeSteps: 16,
    waveTable: null,
    ...c,
  },
  fmWaveforms: id === "adlib" || id === "custom",
  id,
  kinds,
  label,
  sampleRate: id === "snes" ? 32_000 : null,
});
export const STUB_CHIPS: Readonly<Record<ChipId, ChipProfile>> = {
  adlib: base(
    "adlib",
    "AdLib (OPL2)",
    numbered("fm", "fm", 9, { fmOps: 2 }),
    ["fm"],
    {
      dutyCycles: [],
      noise: "white",
      pitch: "free",
      volumeSteps: 64,
    }
  ),
  c64: base("c64", "Commodore 64 (SID)", numbered("voice", "sid", 3), ["sid"], {
    clockHz: 985_248,
    dutyCycles: [],
    filter: true,
    noise: "lfsr23",
  }),
  custom: base(
    "custom",
    "Custom",
    [
      ch("pulse1", "pulse", "Pulse 1"),
      ch("pulse2", "pulse", "Pulse 2"),
      ch("wave", "wave", "Wave"),
      ch("fm1", "fm", "FM 1", { fmOps: 4 }),
      ch("noise", "noise", "Noise"),
    ],
    ["pulse", "triangle", "noise", "wave", "sid", "fm", "sample"],
    {
      dutyCycles: [],
      filter: true,
      masterFx: true,
      noise: "white",
      pan: "free",
      pitch: "free",
      volumeSteps: 0,
    }
  ),
  gameboy: base(
    "gameboy",
    "Game Boy (DMG)",
    [
      ch("pulse1", "pulse", "Pulse 1"),
      ch("pulse2", "pulse", "Pulse 2"),
      ch("wave", "wave", "Wave"),
      ch("noise", "noise", "Noise"),
    ],
    ["pulse", "wave", "noise"],
    { clockHz: 4_194_304, pan: "hard", waveTable: { bits: 4, length: 32 } }
  ),
  genesis: base(
    "genesis",
    "Mega Drive (YM2612)",
    [
      ...numbered("fm", "fm", 6, { fmOps: 4 }),
      ...numbered("psg", "pulse", 3, { fixedDuty: 0.5 }),
      ch("psgNoise", "noise", "PSG Noise"),
    ],
    ["fm", "pulse", "noise"],
    { clockHz: 3_579_545, dutyCycles: [0.5], noise: "lfsr15", pan: "hard" }
  ),
  nes: base(
    "nes",
    "NES (2A03)",
    [
      ch("pulse1", "pulse", "Pulse 1"),
      ch("pulse2", "pulse", "Pulse 2"),
      ch("triangle", "triangle", "Triangle"),
      ch("noise", "noise", "Noise"),
    ],
    ["pulse", "triangle", "noise"],
    { triangleSteps: 32 }
  ),
  snes: base(
    "snes",
    "SNES (samples)",
    numbered("ch", "sample", 8),
    ["sample"],
    {
      dutyCycles: [],
      masterFx: true,
      noise: "white",
      pan: "free",
      pitch: "free",
      volumeSteps: 128,
    }
  ),
};
export const stubChipProfile = (id: ChipId): ChipProfile =>
  STUB_CHIPS[id] ?? STUB_CHIPS.nes;
export const stubChipChannels = (song: Song): readonly ChipChannel[] =>
  song.chip === "custom"
    ? song.channels.map((c) => ch(c.id, c.kind, c.id))
    : stubChipProfile(song.chip).channels;

/* ---------- defaults ---------- */

export function defaultProject(name = "Untitled"): Project {
  return {
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
    name,
    sampleRate: 48_000,
    seed: 1,
    version: FORMAT_VERSION,
  };
}
export function defaultSfx(chip: ChipId = "nes"): Sfx {
  const wave =
    chip === "adlib" || chip === "genesis"
      ? "fm"
      : chip === "gameboy"
        ? "square"
        : "square";
  return {
    arpeggio: { rate: 0, steps: [] },
    bitcrush: { bits: null, rateDivide: 1 },
    category: "custom",
    chip,
    duty: { start: 0.5, sweep: 0 },
    envelope: { attack: 0, decay: 0.2, punch: 0, sustain: 0.1 },
    filter: {
      highpass: null,
      highpassSweep: 0,
      lowpass: null,
      lowpassSweep: 0,
      resonance: 0,
    },
    fm: wave === "fm" ? { index: 2, indexDecay: 0.2, ratio: 2 } : null,
    frequency: { deltaSlide: 0, min: 0, slide: 0, start: 440 },
    name: "Untitled",
    noise: { mode: "long" },
    phaser: { offset: 0, sweep: 0 },
    repeat: { rate: 0 },
    seed: 1,
    table: null,
    version: FORMAT_VERSION,
    vibrato: { depth: 0, rate: 0 },
    volume: 0.7,
    wave,
  };
}
const SINE32 = Array.from({ length: 32 }, (_, i) =>
  Math.round(7.5 + 7.5 * Math.sin((i / 32) * Math.PI * 2))
);
export function defaultInstrument(
  kind: ChannelKind = "pulse",
  chip: ChipId | null = "nes"
): Instrument {
  const op = (level: number, mult: number) => ({
    attack: 31,
    decay: 12,
    detune: 0,
    fixedHz: null,
    keyScale: 0,
    level,
    mult,
    release: 8,
    sustainLevel: 0.6,
    sustainRate: 4,
    waveform: 0,
  });
  return {
    chip,
    envelope: { attack: 0.005, decay: 0.1, release: 0.05, sustain: 0.7 },
    finetune: 0,
    fm:
      kind === "fm"
        ? {
            algorithm: 4,
            feedback: 3,
            lfo: null,
            ops:
              chip === "adlib"
                ? [op(1, 1), op(0.6, 2)]
                : [op(0.8, 1), op(0.7, 2), op(0.9, 1), op(0.8, 1)],
          }
        : null,
    kind,
    macros: {},
    name: "Untitled",
    noise: kind === "noise" ? { mode: "long" } : null,
    pan: 0,
    pulse: kind === "pulse" ? { duty: 0.5 } : null,
    sample:
      kind === "sample"
        ? { baseNote: 60, generator: "pluck", loop: false, params: {}, seed: 1 }
        : null,
    send: { echo: 0, reverb: 0 },
    sid:
      kind === "sid"
        ? {
            filter: { cutoff: 0.5, mode: "off", resonance: 0.2, sweep: 0 },
            pulseWidth: 0.5,
            pwmDepth: 0,
            pwmRate: 0,
            ring: false,
            sync: false,
            waveforms: ["pulse"],
          }
        : null,
    transpose: 0,
    version: FORMAT_VERSION,
    volume: 0.8,
    wave: kind === "wave" ? { table: [...SINE32] } : null,
  };
}
export function defaultSong(chip: ChipId = "nes"): Song {
  const channels = stubChipProfile(chip).channels.map((c) => ({
    id: c.id,
    instrument: null as string | null,
    kind: c.kind,
    mml: null as string | null,
    muted: false,
    pan: 0,
    volume: 1,
  }));
  return {
    channels,
    chip,
    loop: 0,
    master: { echo: null, reverb: null, volume: 0.8 },
    name: "Untitled",
    order: ["pattern-1"],
    patterns: { "pattern-1": { length: 32, tracks: {} } },
    rowsPerBeat: 4,
    tempo: 120,
    tickRate: 60,
    version: FORMAT_VERSION,
  };
}

/* ---------- normalize (light: defaults merged, no range checks) ---------- */

function ok<T>(value: T, issues: Issue[] = []): Normalized<T> {
  return { issues, ok: issues.every((i) => i.severity !== "error"), value };
}
function expandRow(r: Record<string, unknown>): Row {
  const row = Number(r.row ?? 0);
  if (typeof r.s === "string") {
    const parts = r.s.split(/\s+/).filter(Boolean);
    const out: Row = { fx: [], inst: null, note: null, row, vol: null };
    for (const [i, p] of parts.entries()) {
      if (i === 0) {
        if (p.toUpperCase() === "OFF") {
          out.note = "off";
        } else if (p.toUpperCase() === "REL") {
          out.note = "release";
        } else {
          out.note = parseNoteName(p);
        }
      } else if (/^v[0-9a-f]$/i.test(p)) {
        out.vol = Number.parseInt(p.slice(1), 16);
      } else if (p === "." || p === "--") {
        // empty field
      } else {
        const fx = parseEffect(p);
        if (fx) {
          out.fx.push(fx);
        } else {
          out.inst = p;
        }
      }
    }
    return out;
  }
  return {
    fx: ((r.fx as unknown[]) ?? [])
      .map((f) => (typeof f === "string" ? parseEffect(f) : (f as Effect)))
      .filter((f): f is Effect => !!f),
    inst: (r.inst as string | null) ?? null,
    note: (r.note as Row["note"]) ?? null,
    row,
    vol: (r.vol as number | null) ?? null,
  };
}
export const stubNormalizeProject = (input: unknown): Normalized<Project> =>
  ok(merge(defaultProject(), input));
export function stubNormalizeSfx(input: unknown): Normalized<Sfx> {
  const chip =
    isObj(input) && CHIP_IDS.includes(input.chip as ChipId)
      ? (input.chip as ChipId)
      : "nes";
  const v = merge(defaultSfx(chip), input);
  if (isObj(input) && isObj(input.fm)) {
    v.fm = merge({ index: 2, indexDecay: 0.2, ratio: 2 }, input.fm);
  }
  if (isObj(input) && Array.isArray(input.table)) {
    v.table = input.table.map((x: unknown) =>
      Math.max(0, Math.min(15, Math.round(Number(x) || 0)))
    );
  }
  return ok(v);
}
export function stubNormalizeInstrument(
  input: unknown
): Normalized<Instrument> {
  const kind =
    isObj(input) && typeof input.kind === "string"
      ? (input.kind as ChannelKind)
      : "pulse";
  const v = merge(defaultInstrument(kind, null), input);
  const patch = (input ?? {}) as Record<string, unknown>;
  for (const k of ["pulse", "wave", "noise", "sid", "fm", "sample"] as const) {
    if (patch[k] === null) {
      (v as unknown as Record<string, unknown>)[k] = null;
    }
  }
  v.macros = isObj(patch.macros)
    ? (clone(patch.macros) as Instrument["macros"])
    : {};
  v.chip = (patch.chip as ChipId | null | undefined) ?? null;
  return ok(v);
}
export function stubNormalizeSong(input: unknown): Normalized<Song> {
  const chip =
    isObj(input) && CHIP_IDS.includes(input.chip as ChipId)
      ? (input.chip as ChipId)
      : "nes";
  const d = defaultSong(chip);
  const src = isObj(input) ? input : {};
  const v = merge({ ...d, channels: [], order: [], patterns: {} } as Song, src);
  v.channels = Array.isArray(src.channels)
    ? (src.channels as unknown[]).map((c, i) => {
        const base = d.channels[i] ?? d.channels[0];
        return merge(base as Song["channels"][number], c);
      })
    : d.channels;
  v.patterns = {};
  for (const [id, p] of Object.entries(
    isObj(src.patterns) ? src.patterns : {}
  )) {
    const pat = p as { length?: number; tracks?: Record<string, unknown[]> };
    v.patterns[id] = {
      length: Math.max(1, Math.min(256, Number(pat.length) || 64)),
      tracks: Object.fromEntries(
        Object.entries(pat.tracks ?? {}).map(([cid, rows]) => [
          cid,
          (rows as Record<string, unknown>[])
            .map(expandRow)
            .sort((a, b) => a.row - b.row),
        ])
      ),
    };
  }
  v.order = Array.isArray(src.order)
    ? (src.order as string[]).filter((o) => o in v.patterns)
    : [];
  if (
    v.order.length === 0 &&
    Object.keys(v.patterns).length > 0 &&
    !v.channels.some((c) => c.mml)
  ) {
    v.order = [Object.keys(v.patterns)[0] ?? ""];
  }
  return ok(v);
}

/* ---------- MML (just enough for the fake engine and the tracker conversion) ---------- */

export function stubParseMml(src: string): {
  events: MmlEvent[];
  issues: Issue[];
  loopPulse: number | null;
  tempo: number | null;
} {
  const events: MmlEvent[] = [];
  const issues: Issue[] = [];
  const text = src.replace(/;[^\n]*/g, "");
  let i = 0;
  let octave = 4;
  let length = 8;
  let volume = 15;
  let pulse = 0;
  let loopPulse: number | null = null;
  let tempo: number | null = null;
  const stack: { start: number; at: number }[] = [];
  const raw: string[] = [];
  const readNum = (): number | null => {
    const m = /^-?\d+/.exec(text.slice(i));
    if (!m) {
      return null;
    }
    i += m[0].length;
    return Number(m[0]);
  };
  const expand = (): string => {
    // unroll [ ... ]n
    let s = text;
    for (let guard = 0; guard < 8 && /\[[^[\]]*\]\d*/.test(s); guard++) {
      s = s.replace(/\[([^[\]]*)\](\d*)/g, (_m, body: string, n: string) =>
        body.repeat(Math.max(1, Number(n) || 2))
      );
    }
    return s;
  };
  const flat = expand();
  const t = flat;
  void raw;
  void stack;
  i = 0;
  const pendingTie: { idx: number } | null = null;
  void pendingTie;
  const dur = (n: number | null): number => {
    let d = 384 / (n ?? length);
    let add = d / 2;
    while (t[i] === ".") {
      d += add;
      add /= 2;
      i++;
    }
    return d;
  };
  const seminote: Record<string, number> = {
    a: 9,
    b: 11,
    c: 0,
    d: 2,
    e: 4,
    f: 5,
    g: 7,
  };
  let lastNote: Extract<MmlEvent, { type: "note" }> | null = null;
  while (i < t.length) {
    const c = t[i] ?? "";
    const at = i;
    i++;
    if (/\s|\|/.test(c)) {
      continue;
    }
    if (c in seminote) {
      let n = (seminote[c] ?? 0) + (octave + 1) * 12;
      while (t[i] === "+" || t[i] === "#" || t[i] === "-") {
        n += t[i] === "-" ? -1 : 1;
        i++;
      }
      const len = readNum();
      const d = dur(len);
      if (t[i] === "&" && lastNote === null) {
        i++;
      }
      const ev: Extract<MmlEvent, { type: "note" }> = {
        duration: d,
        fx: [],
        gate: d,
        inst: null,
        note: n,
        pulse,
        type: "note",
        volume,
      };
      events.push(ev);
      lastNote = ev;
      pulse += d;
    } else if (c === "r") {
      const d = dur(readNum());
      events.push({ duration: d, pulse, type: "rest" });
      pulse += d;
    } else if (c === "o") {
      octave = readNum() ?? octave;
    } else if (c === ">") {
      octave++;
    } else if (c === "<") {
      octave--;
    } else if (c === "l") {
      length = readNum() ?? length;
    } else if (c === "v") {
      volume = readNum() ?? volume;
      events.push({ pulse, type: "volume", value: volume });
    } else if (c === "t") {
      tempo = readNum() ?? tempo;
    } else if (c === "@") {
      const m = /^[A-Za-z0-9-]+/.exec(t.slice(i));
      if (m) {
        i += m[0].length;
        events.push({ id: m[0], pulse, type: "inst" });
      }
    } else if (c === "L") {
      loopPulse ??= pulse;
      events.push({ pulse, type: "loop" });
    } else if (/[pqkw]/.test(c)) {
      readNum();
    } else if (c === "{") {
      const end = t.indexOf("}", i);
      i = end < 0 ? t.length : end + 1;
    } else if (c !== "&" && c !== "[" && c !== "]") {
      issues.push({
        message: `unexpected "${c}" at offset ${at}`,
        path: "",
        severity: "error",
      });
    }
  }
  return { events, issues, loopPulse, tempo };
}
export function stubMmlToTrack(
  src: string,
  rowsPerBeat: number
): { rows: Row[]; issues: Issue[]; loopRow: number | null } {
  const { events, issues, loopPulse } = stubParseMml(src);
  const perRow = 96 / rowsPerBeat;
  const rows: Row[] = [];
  let inst: string | null = null;
  for (const e of events) {
    if (e.type === "inst") {
      inst = e.id;
    } else if (e.type === "note") {
      const row = Math.round(e.pulse / perRow);
      rows.push({ fx: [], inst, note: e.note, row, vol: e.volume });
      const off = Math.round((e.pulse + e.gate) / perRow);
      if (off > row) {
        rows.push({ fx: [], inst: null, note: "off", row: off, vol: null });
      }
      inst = null;
    }
  }
  const merged = new Map<number, Row>();
  for (const r of rows) {
    const cur = merged.get(r.row);
    if (!cur || r.note !== "off") {
      merged.set(r.row, r);
    }
  }
  return {
    issues,
    loopRow: loopPulse === null ? null : Math.round(loopPulse / perRow),
    rows: [...merged.values()].sort((a, b) => a.row - b.row),
  };
}
export function stubPatternToMml(
  rows: readonly Row[],
  rowsPerBeat: number
): string {
  const perRow = 96 / rowsPerBeat;
  void perRow;
  const out: string[] = [];
  let octave = 4;
  let last = 0;
  const names = [
    "c",
    "c+",
    "d",
    "d+",
    "e",
    "f",
    "f+",
    "g",
    "g+",
    "a",
    "a+",
    "b",
  ];
  const len = Math.max(1, Math.round(16 / (4 / rowsPerBeat)));
  for (const r of rows) {
    if (r.row > last) {
      out.push(`r${len}`.repeat(r.row - last));
    }
    if (typeof r.note === "number") {
      const o = Math.floor(r.note / 12) - 1;
      if (o !== octave) {
        out.push(`o${o}`);
        octave = o;
      }
      out.push(`${names[r.note % 12]}${len}`);
    }
    last = r.row + 1;
  }
  return out.join(" ");
}

/* ---------- sfx generators (stand-ins for @bleepkit/sfx) ---------- */

type Range = [number, number];
const rnd = (r: () => number, [a, b]: Range) => a + (b - a) * r();
interface CatSpec {
  arp?: number[];
  arpRate?: number;
  bits?: number;
  decay: Range;
  delta?: Range;
  freq: Range;
  lowpass?: Range;
  punch?: Range;
  repeat?: Range;
  slide: Range;
  sustain: Range;
  vibrato?: [number, number];
  wave: Sfx["wave"];
}
const CAT: Record<SfxCategory, CatSpec> = {
  alarm: {
    arp: [0, 7],
    arpRate: 6,
    decay: [0.1, 0.2],
    freq: [500, 900],
    repeat: [4, 8],
    slide: [0, 0],
    sustain: [0.3, 0.6],
    wave: "square",
  },
  blip: {
    decay: [0.04, 0.1],
    freq: [600, 1400],
    slide: [0, 0.3],
    sustain: [0.02, 0.05],
    wave: "square",
  },
  coin: {
    arp: [5, 7, 12],
    arpRate: 12,
    decay: [0.15, 0.35],
    freq: [900, 1500],
    punch: [0.2, 0.5],
    slide: [0, 0],
    sustain: [0.03, 0.09],
    wave: "square",
  },
  custom: {
    decay: [0.1, 0.4],
    freq: [200, 1200],
    slide: [-2, 2],
    sustain: [0.05, 0.3],
    wave: "square",
  },
  door: {
    decay: [0.2, 0.5],
    freq: [120, 260],
    slide: [-0.6, 0.6],
    sustain: [0.1, 0.3],
    vibrato: [0.3, 25],
    wave: "triangle",
  },
  explosion: {
    decay: [0.35, 0.9],
    freq: [60, 220],
    lowpass: [900, 3500],
    punch: [0.3, 0.7],
    slide: [-1.2, -0.2],
    sustain: [0.1, 0.35],
    wave: "noise",
  },
  hit: {
    decay: [0.07, 0.18],
    freq: [250, 700],
    lowpass: [2000, 6000],
    punch: [0.4, 0.8],
    slide: [-3, -1],
    sustain: [0.02, 0.07],
    wave: "noise",
  },
  jump: {
    decay: [0.1, 0.22],
    freq: [250, 450],
    slide: [1.5, 3.5],
    sustain: [0.04, 0.1],
    wave: "square",
  },
  laser: {
    decay: [0.08, 0.25],
    freq: [900, 2200],
    punch: [0, 0.3],
    slide: [-5, -2],
    sustain: [0.05, 0.2],
    wave: "square",
  },
  powerup: {
    decay: [0.2, 0.4],
    freq: [200, 500],
    punch: [0, 0.2],
    slide: [1.5, 3.5],
    sustain: [0.1, 0.25],
    vibrato: [0.2, 14],
    wave: "square",
  },
  step: {
    decay: [0.04, 0.09],
    freq: [120, 300],
    lowpass: [800, 2500],
    slide: [-2, -0.5],
    sustain: [0.01, 0.03],
    wave: "noise",
  },
  teleport: {
    arp: [0, 12, 7, 19],
    arpRate: 24,
    decay: [0.3, 0.6],
    freq: [200, 600],
    slide: [1, 4],
    sustain: [0.2, 0.4],
    vibrato: [0.6, 30],
    wave: "saw",
  },
  zap: {
    decay: [0.1, 0.3],
    freq: [400, 1800],
    slide: [-4, 2],
    sustain: [0.05, 0.15],
    vibrato: [0.5, 30],
    wave: "square",
  },
};
const waveForChip = (w: Sfx["wave"], chip: ChipId): Sfx["wave"] => {
  const allowed: Record<ChipId, Sfx["wave"][]> = {
    adlib: ["fm", "square", "sine", "saw"],
    c64: ["square", "saw", "triangle", "noise"],
    custom: ["square", "triangle", "saw", "sine", "noise", "wave", "fm"],
    gameboy: ["square", "wave", "noise"],
    genesis: ["square", "noise", "fm"],
    nes: ["square", "triangle", "noise"],
    snes: ["sine", "triangle", "saw", "square", "noise"],
  };
  const list = allowed[chip];
  return list.includes(w) ? w : (list[0] ?? "square");
};
export function stubGenerateSfx(
  category: SfxCategory,
  opts: { seed: number; chip?: ChipId; name?: string }
): Sfx {
  const r = mulberry32(opts.seed * 7919 + hashString(category));
  const spec = CAT[category];
  const chip = opts.chip ?? "nes";
  const sfx = defaultSfx(chip);
  sfx.name =
    opts.name ??
    `${category[0]?.toUpperCase()}${category.slice(1)} ${opts.seed}`;
  sfx.category = category;
  sfx.seed = opts.seed;
  sfx.wave = waveForChip(spec.wave, chip);
  sfx.volume = 0.6;
  sfx.frequency = {
    deltaSlide: spec.delta ? rnd(r, spec.delta) : 0,
    min: 0,
    slide: rnd(r, spec.slide),
    start: rnd(r, spec.freq),
  };
  sfx.envelope = {
    attack: 0,
    decay: rnd(r, spec.decay),
    punch: spec.punch ? rnd(r, spec.punch) : 0,
    sustain: rnd(r, spec.sustain),
  };
  if (spec.arp) {
    sfx.arpeggio = { rate: spec.arpRate ?? 10, steps: [...spec.arp] };
  }
  if (spec.vibrato) {
    sfx.vibrato = { depth: spec.vibrato[0], rate: spec.vibrato[1] };
  }
  if (spec.repeat) {
    sfx.repeat = { rate: rnd(r, spec.repeat) };
  }
  if (spec.lowpass) {
    sfx.filter.lowpass = rnd(r, spec.lowpass);
  }
  sfx.duty.start = [0.125, 0.25, 0.5, 0.75][Math.floor(r() * 4)] ?? 0.5;
  if (sfx.wave === "fm") {
    sfx.fm = {
      index: 1 + r() * 4,
      indexDecay: 0.2,
      ratio: 1 + Math.floor(r() * 4),
    };
  }
  if (sfx.wave === "wave") {
    sfx.table = Array.from({ length: 32 }, (_, i) =>
      Math.round(7.5 + 7.5 * Math.sin((i / 32) * Math.PI * 2))
    );
  }
  return stubNormalizeSfx(sfx).value;
}
export function stubMutateSfx(
  sfx: Sfx,
  opts: { seed: number; amount?: number }
): Sfx {
  const r = mulberry32(opts.seed);
  const a = opts.amount ?? 0.15;
  const out = clone(sfx);
  const nudge = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, v + (r() - 0.5) * 2 * a * (hi - lo)));
  if (r() < 0.8) {
    out.frequency.start = Math.max(
      20,
      out.frequency.start * (1 + (r() - 0.5) * 2 * a)
    );
  }
  if (r() < 0.6) {
    out.frequency.slide = nudge(out.frequency.slide, -8, 8);
  }
  if (r() < 0.6) {
    out.envelope.sustain = nudge(out.envelope.sustain, 0.01, 0.6);
  }
  if (r() < 0.6) {
    out.envelope.decay = nudge(out.envelope.decay, 0.03, 0.8);
  }
  if (r() < 0.3) {
    out.vibrato.depth = nudge(out.vibrato.depth, 0, 1);
    out.vibrato.rate = nudge(out.vibrato.rate, 0, 40);
  }
  if (r() < 0.3) {
    out.duty.start = nudge(out.duty.start, 0.1, 0.9);
  }
  out.seed = (opts.seed >>> 0) % 100_000;
  return out;
}
export const stubMutateMany = (
  sfx: Sfx,
  o: { seed: number; amount?: number; count: number }
): Sfx[] =>
  Array.from({ length: o.count }, (_, i) =>
    stubMutateSfx(sfx, {
      seed: o.seed + i * 977,
      ...(o.amount === undefined ? {} : { amount: o.amount }),
    })
  );
export function stubRandomizeSfx(sfx: Sfx, seed: number): Sfx {
  return {
    ...stubGenerateSfx(sfx.category, { chip: sfx.chip, name: sfx.name, seed }),
  };
}
export function stubDescribeSfx(sfx: Sfx): string {
  const dur = sfx.envelope.attack + sfx.envelope.sustain + sfx.envelope.decay;
  const dir =
    sfx.frequency.slide > 0.3
      ? "rising"
      : sfx.frequency.slide < -0.3
        ? "falling"
        : "steady";
  return `A ${dir} ${sfx.wave} ${sfx.category}, ${dur.toFixed(2)} s, starting near ${Math.round(sfx.frequency.start)} Hz.`;
}

/* ---------- a rough renderer (the fake engine plays what this makes) ---------- */

export function stubRenderSfx(
  sfx: Sfx,
  opts: RenderOptions = {}
): RenderResult {
  const sr = opts.sampleRate ?? 48_000;
  const e = sfx.envelope;
  const dur =
    Math.min(10, e.attack + e.sustain + e.decay) + (opts.tail ?? 0.05);
  const frames = Math.max(64, Math.floor(dur * sr));
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  const noise = mulberry32(sfx.seed || 1);
  let phase = 0;
  let nval = 0;
  let nph = 0;
  let lp = 0;
  const events: EngineEvent[] = [];
  const bits = sfx.bitcrush.bits;
  let hold = 0;
  let held = 0;
  const rep = sfx.repeat.rate;
  for (let i = 0; i < frames; i++) {
    let t = i / sr;
    if (rep > 0) {
      t %= 1 / rep;
    }
    const total = e.attack + e.sustain + e.decay;
    if (t > total) {
      continue;
    }
    let env: number;
    if (t < e.attack) {
      env = t / Math.max(1e-6, e.attack);
    } else if (t < e.attack + e.sustain) {
      env =
        1 + e.punch * (1 - (t - e.attack) / Math.max(1e-6, e.sustain)) * 0.8;
    } else {
      env = (1 - (t - e.attack - e.sustain) / Math.max(1e-6, e.decay)) ** 2;
    }
    let f =
      sfx.frequency.start *
      2 ** (sfx.frequency.slide * t + 0.5 * sfx.frequency.deltaSlide * t * t);
    if (sfx.arpeggio.rate > 0 && sfx.arpeggio.steps.length > 0) {
      const step =
        Math.floor(t * sfx.arpeggio.rate) % (sfx.arpeggio.steps.length + 1);
      f *= 2 ** (((step === 0 ? 0 : sfx.arpeggio.steps[step - 1]) ?? 0) / 12);
    }
    if (sfx.vibrato.rate > 0) {
      f *=
        2 **
        ((sfx.vibrato.depth * Math.sin(t * sfx.vibrato.rate * Math.PI * 2)) /
          12);
    }
    if (sfx.frequency.min > 0 && f < sfx.frequency.min) {
      break;
    }
    f = Math.min(f, sr / 2.2);
    phase = (phase + f / sr) % 1;
    let s = 0;
    switch (sfx.wave) {
      case "square": {
        const duty = Math.max(
          0.05,
          Math.min(0.95, sfx.duty.start + sfx.duty.sweep * t)
        );
        s = phase < duty ? 1 : -1;
        break;
      }
      case "triangle":
        s = Math.abs(phase * 4 - 2) - 1;
        break;
      case "saw":
        s = phase * 2 - 1;
        break;
      case "sine":
        s = Math.sin(phase * Math.PI * 2);
        break;
      case "noise":
        nph += f / sr;
        if (nph >= 1) {
          nph -= 1;
          nval = noise() * 2 - 1;
        }
        s = nval;
        break;
      case "wave": {
        const tab = sfx.table ?? [];
        s = ((tab[Math.floor(phase * 32) % 32] ?? 8) / 7.5 - 1) * 0.9;
        break;
      }
      default: {
        const fm = sfx.fm ?? { index: 2, indexDecay: 0.2, ratio: 2 };
        const idx = fm.index * Math.exp(-t / Math.max(0.01, fm.indexDecay));
        s = Math.sin(
          phase * Math.PI * 2 + idx * Math.sin(phase * Math.PI * 2 * fm.ratio)
        );
      }
    }
    if (sfx.filter.lowpass) {
      const a = Math.min(1, (sfx.filter.lowpass * 2 * Math.PI) / sr);
      lp += a * (s - lp);
      s = lp;
    }
    if (bits) {
      const q = 2 ** (bits - 1);
      s = Math.round(s * q) / q;
    }
    if (sfx.bitcrush.rateDivide > 1) {
      if (hold++ % sfx.bitcrush.rateDivide === 0) {
        held = s;
      }
      s = held;
    }
    const v = s * env * sfx.volume * 0.5;
    L[i] = v;
    R[i] = v;
  }
  events.push({
    channel: -1,
    channelId: "",
    frame: 0,
    hz: sfx.frequency.start,
    id: "",
    note: 0,
    order: -1,
    row: -1,
    type: "trigger",
    velocity: 1,
  });
  return { channels: [L, R], events, frames, sampleRate: sr };
}

export function stubRenderSong(
  song: Song,
  instruments: Record<string, Instrument>,
  opts: RenderOptions = {}
): RenderResult {
  const sr = opts.sampleRate ?? 48_000;
  const chans = stubChipChannels(song);
  const framesPerPulse = (sr * 60) / (song.tempo * 96);
  const events: EngineEvent[] = [];
  type Note = {
    ch: number;
    start: number;
    end: number;
    note: number;
    inst: string | null;
    vol: number;
  };
  const notes: Note[] = [];
  const mkEv = (
    type: EngineEvent["type"],
    frame: number,
    c: number,
    extra: Partial<EngineEvent> = {}
  ): EngineEvent => ({
    channel: c,
    channelId: chans[c]?.id ?? "",
    frame,
    hz: 0,
    id: "",
    note: 0,
    order: -1,
    row: -1,
    type,
    velocity: 0,
    ...extra,
  });
  const perRow = 96 / song.rowsPerBeat;
  let pulse = 0;
  const orderStarts: number[] = [];
  for (const [oi, pid] of song.order.entries()) {
    orderStarts.push(pulse);
    const pat = song.patterns[pid];
    if (!pat) {
      continue;
    }
    for (let r = 0; r < pat.length; r++) {
      events.push(
        mkEv("row", Math.floor((pulse + r * perRow) * framesPerPulse), -1, {
          id: pid,
          order: oi,
          row: r,
        })
      );
    }
    for (const [ci, c] of chans.entries()) {
      const sc = song.channels.find((x) => x.id === c.id);
      if (!sc || sc.muted) {
        continue;
      }
      const rows = sc.mml
        ? stubMmlToTrack(sc.mml, song.rowsPerBeat).rows
        : (pat.tracks[c.id] ?? []);
      const trackRows = sc.mml ? rows.filter((x) => x.row < pat.length) : rows;
      let cur: Note | null = null;
      let inst = sc.instrument;
      for (const row of trackRows) {
        const at = pulse + row.row * perRow;
        if (row.inst) {
          inst = row.inst;
        }
        if (row.note === "off" || row.note === "release") {
          if (cur) {
            cur.end = at;
            cur = null;
          }
        } else if (typeof row.note === "number") {
          if (cur) {
            cur.end = at;
          }
          cur = {
            ch: ci,
            end: pulse + pat.length * perRow,
            inst,
            note: row.note,
            start: at,
            vol: (row.vol ?? 15) / 15,
          };
          notes.push(cur);
        }
      }
    }
    pulse += pat.length * perRow;
  }
  orderStarts.push(pulse);
  const loopStartPulse =
    song.loop === null ? null : (orderStarts[song.loop] ?? 0);
  const total = Math.max(1, Math.floor(pulse * framesPerPulse));
  const tailFrames = Math.floor((opts.tail ?? 1) * sr);
  const frames = total + tailFrames;
  const stems = chans.map(() => new Float32Array(frames));
  for (const n of notes) {
    const a = Math.floor(n.start * framesPerPulse);
    const b = Math.min(frames, Math.floor(n.end * framesPerPulse));
    const inst = n.inst ? instruments[n.inst] : undefined;
    const kind = inst?.kind ?? chans[n.ch]?.kind ?? "pulse";
    const stem = stems[n.ch];
    if (!stem) {
      continue;
    }
    const hz = noteToHz(n.note + (inst?.transpose ?? 0));
    const env = inst?.envelope ?? {
      attack: 0.005,
      decay: 0.1,
      release: 0.05,
      sustain: 0.7,
    };
    const duty = inst?.pulse?.duty ?? 0.5;
    let ph = 0;
    let nv = 0;
    const r = mulberry32(a + 1);
    const rel = Math.floor(env.release * sr);
    for (let i = a; i < Math.min(frames, b + rel); i++) {
      const t = (i - a) / sr;
      let g: number;
      if (i < b) {
        g =
          t < env.attack
            ? t / Math.max(1e-6, env.attack)
            : env.sustain +
              (1 - env.sustain) *
                Math.exp(-(t - env.attack) / Math.max(0.01, env.decay / 3));
      } else {
        const t0 = (b - a) / sr;
        const g0 =
          t0 < env.attack
            ? t0 / Math.max(1e-6, env.attack)
            : env.sustain +
              (1 - env.sustain) *
                Math.exp(-(t0 - env.attack) / Math.max(0.01, env.decay / 3));
        g = g0 * Math.max(0, 1 - (i - b) / Math.max(1, rel));
      }
      const f = kind === "noise" ? 4000 : hz;
      ph = (ph + f / sr) % 1;
      let s: number;
      switch (kind) {
        case "triangle":
          s = Math.abs(ph * 4 - 2) - 1;
          break;
        case "noise":
          if (ph < f / sr) {
            nv = r() * 2 - 1;
          }
          s = nv * Math.exp(-t * 18);
          break;
        case "sid":
          s = ph * 2 - 1;
          break;
        case "fm":
          s = Math.sin(
            ph * Math.PI * 2 +
              2.5 * Math.exp(-t * 6) * Math.sin(ph * Math.PI * 4)
          );
          break;
        case "sample":
          s = Math.sin(ph * Math.PI * 2) * Math.exp(-t * 4);
          break;
        case "wave": {
          const tab = inst?.wave?.table ?? [];
          s = (tab[Math.floor(ph * 32) % 32] ?? 8) / 7.5 - 1;
          break;
        }
        default:
          s = ph < duty ? 1 : -1;
      }
      stem[i] = (stem[i] ?? 0) + s * g * n.vol * (inst?.volume ?? 0.8) * 0.28;
    }
    events.push(
      mkEv("noteOn", a, n.ch, {
        hz,
        id: n.inst ?? "",
        note: n.note,
        velocity: n.vol,
      }),
      mkEv("noteOff", b, n.ch)
    );
  }
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (const [ci, stem] of stems.entries()) {
    const sc = song.channels.find((x) => x.id === chans[ci]?.id);
    const vol = (sc?.volume ?? 1) * song.master.volume;
    for (let i = 0; i < frames; i++) {
      const v = (stem[i] ?? 0) * vol;
      L[i] = (L[i] ?? 0) + v;
      R[i] = (R[i] ?? 0) + v;
    }
  }
  events.sort((x, y) => x.frame - y.frame);
  events.push(mkEv("end", frames - 1, -1));
  const result: RenderResult = {
    channels: [L, R],
    events,
    frames,
    sampleRate: sr,
    stemIds: chans.map((c) => c.id),
    stems,
  };
  if (loopStartPulse !== null) {
    result.loopStart = Math.floor(loopStartPulse * framesPerPulse);
    result.loopEnd = total;
  }
  return result;
}

export function stubRenderInstrumentNote(
  inst: Instrument,
  note: number,
  opts: RenderOptions & {
    chip?: ChipId;
    duration?: number;
    release?: number;
  } = {}
): RenderResult {
  const song = defaultSong("custom");
  const sr = opts.sampleRate ?? 48_000;
  const dur = opts.duration ?? 0.5;
  const kindChannel =
    song.channels.find((c) => c.kind === inst.kind) ?? song.channels[0];
  song.channels = kindChannel ? [{ ...kindChannel, instrument: "i" }] : [];
  song.tempo = 120;
  song.patterns = {
    p: {
      length: 64,
      tracks: {
        [kindChannel?.id ?? "pulse1"]: [
          { fx: [], inst: "i", note, row: 0, vol: 15 },
          {
            fx: [],
            inst: null,
            note: "off",
            row: Math.max(1, Math.round(dur * 8)),
            vol: null,
          },
        ],
      },
    },
  };
  song.order = ["p"];
  song.loop = null;
  const r = stubRenderSong(
    song,
    { i: inst },
    { sampleRate: sr, tail: opts.release ?? 0.5 }
  );
  const keep = Math.floor((dur + (opts.release ?? 0.5)) * sr);
  return {
    ...r,
    channels: r.channels.map((c) => c.slice(0, keep)),
    events: [],
    frames: Math.min(r.frames, keep),
  };
}

/* ---------- analysis ---------- */

export interface StubAnalysis {
  channels: number;
  clipped: { frames: number; first: number | null };
  crestDb: number;
  dcOffset: number;
  duration: number;
  dutyCycle: number | null;
  envelope: { time: number; db: number }[];
  file: string;
  frames: number;
  leadingSilence: number;
  loop: { start: number; end: number; seamDiffDb: number } | null;
  lufs: number;
  peakDb: number;
  pitch: {
    medianHz: number | null;
    medianNote: string | null;
    track: { time: number; hz: number | null; confidence: number }[];
  };
  rmsDb: number;
  sampleRate: number;
  silenceDb: number;
  spectrum: {
    centroidHz: number;
    bands: { lowDb: number; midDb: number; highDb: number };
  };
  trailingSilence: number;
}
const db = (x: number) => (x <= 1e-9 ? -120 : 20 * Math.log10(x));
export function stubAnalyze(r: RenderResult, file = ""): StubAnalysis {
  const mono = new Float32Array(r.frames);
  for (let i = 0; i < r.frames; i++) {
    mono[i] =
      ((r.channels[0]?.[i] ?? 0) +
        (r.channels[1]?.[i] ?? r.channels[0]?.[i] ?? 0)) /
      2;
  }
  let peak = 0;
  let sum = 0;
  let dc = 0;
  let clipped = 0;
  let first: number | null = null;
  for (let i = 0; i < mono.length; i++) {
    const v = mono[i] ?? 0;
    peak = Math.max(peak, Math.abs(v));
    sum += v * v;
    dc += v;
    if (Math.abs(v) >= 0.999) {
      clipped++;
      first ??= i / r.sampleRate;
    }
  }
  const rms = Math.sqrt(sum / Math.max(1, mono.length));
  const hop = Math.max(1, Math.floor(r.sampleRate * 0.01));
  const envelope: StubAnalysis["envelope"] = [];
  for (let i = 0; i < mono.length && envelope.length < 1000; i += hop) {
    let s = 0;
    const n = Math.min(hop, mono.length - i);
    for (let k = 0; k < n; k++) {
      s += (mono[i + k] ?? 0) ** 2;
    }
    envelope.push({ db: db(Math.sqrt(s / n)), time: i / r.sampleRate });
  }
  const above = envelope.filter((e) => e.db > -60);
  const lead = above[0]?.time ?? 0;
  const tail = r.frames / r.sampleRate - (above.at(-1)?.time ?? 0);
  let zc = 0;
  let prev = 0;
  for (let i = 0; i < mono.length; i++) {
    const v = mono[i] ?? 0;
    if (prev <= 0 && v > 0) {
      zc++;
    }
    prev = v;
  }
  const hz = zc / Math.max(0.01, mono.length / r.sampleRate);
  return {
    channels: 2,
    clipped: { first, frames: clipped },
    crestDb: db(peak) - db(rms),
    dcOffset: dc / Math.max(1, mono.length),
    duration: r.frames / r.sampleRate,
    dutyCycle: null,
    envelope,
    file,
    frames: r.frames,
    leadingSilence: lead,
    loop:
      r.loopStart === undefined || r.loopEnd === undefined
        ? null
        : {
            end: r.loopEnd / r.sampleRate,
            seamDiffDb: -42,
            start: r.loopStart / r.sampleRate,
          },
    lufs: db(rms) - 0.7,
    peakDb: db(peak),
    pitch: {
      medianHz: hz > 20 ? hz : null,
      medianNote: hz > 20 ? noteName(hzToNote(hz)) : null,
      track: [],
    },
    rmsDb: db(rms),
    sampleRate: r.sampleRate,
    silenceDb: Math.min(...envelope.map((e) => e.db), 0),
    spectrum: {
      bands: { highDb: db(rms) - 12, lowDb: db(rms) - 3, midDb: db(rms) - 1 },
      centroidHz: hz * 2.5,
    },
    trailingSilence: Math.max(0, tail),
  };
}
