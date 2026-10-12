/* MOD import (architecture.md section 2.11): a ProTracker module becomes an amiga song, one sample instrument per
   used sample and the samples themselves. Timing is converted so the song lasts as long as the module does: a row of
   `speed` ticks at `BPM` lasts speed * 2.5 / BPM seconds, a Bleepkit row 60 / (tempo * rowsPerBeat). Effects are
   mapped to Bleepkit's table with their units converted; what has no counterpart is counted in a warning. */

import {
  MOD_C2_NOTE,
  MOD_NOTE_HIGH,
  MOD_NOTE_LOW,
  MOD_SAMPLE_RATE,
  nearestNote,
} from "../chips/amiga.ts";
import { CUSTOM_MAX_CHANNELS } from "../chips/custom.ts";
import { defaultInstrument, defaultSong } from "../normalize/defaults.ts";
import { effectFromByte } from "../normalize/effects.ts";
import { normalizeSong } from "../normalize/song.ts";
import { bytesToBase64 } from "../samples/user.ts";
import type {
  Effect,
  EffectType,
  Instrument,
  Issue,
  Pattern,
  Row,
  Song,
  UserSample,
} from "../types.ts";
import { FORMAT_VERSION } from "../types.ts";
import type { ModCell, ModFile } from "./parse.ts";
import { parseMod } from "./parse.ts";

export interface ModToSongOptions {
  /** Song id: the prefix of the instrument and sample ids (default "mod"). */
  id?: string;
  /** False plays the song once (default true: it loops to the restart position, or to the start). */
  loop?: boolean;
  /** The song's name (default the module's title). */
  name?: string;
  /** Stereo separation 0 to 1 (default 1, Paula's hard panning). */
  separation?: number;
}

export interface ModInfo {
  bpm: number;
  channels: number;
  orderLength: number;
  patternsUsed: number;
  rowsPerBeat: number;
  samplesUsed: number;
  speed: number;
  tag: string;
  tempo: number;
  title: string;
}

export interface ModImport {
  info: ModInfo | null;
  /** New instruments by id (one per used sample). */
  instruments: Record<string, Instrument>;
  /** `info` says what was converted, `warning` what was lost or changed, `error` that nothing could be read. */
  issues: Issue[];
  /** New samples by id. */
  samples: Record<string, UserSample>;
  song: Song;
}

const DEFAULT_SPEED = 6;
const DEFAULT_BPM = 125;
const TICK_RATE = 50;
/** Tempo effects hold a byte: 32 to 255 BPM. */
const EFFECT_TEMPO_MIN = 32;
const EFFECT_TEMPO_MAX = 255;
const R_CHOICES = [4, 8, 2, 6, 3, 12, 16, 1, 5, 7, 9, 10, 11, 13, 14, 15];

function note(i: Issue["severity"], message: string, path = ""): Issue {
  return { message, path, severity: i };
}

/* ---------- timing ---------- */

interface Timing {
  bpm: number;
  rowsPerBeat: number;
  speed: number;
  tempo: number;
}

/** Bleepkit tempo for a speed and BPM at `r` rows per beat. */
function tempoOf(speed: number, bpm: number, r: number): number {
  return (24 * bpm) / (r * speed);
}

/** Every F effect of the module, in the order of the order list. */
function tempoEvents(file: ModFile): { bpm: boolean; value: number }[] {
  const out: { bpm: boolean; value: number }[] = [];
  const seen = new Set<number>();
  for (const p of file.order) {
    if (seen.has(p)) {
      continue;
    }
    seen.add(p);
    for (const row of file.patterns[p] ?? []) {
      for (const cell of row) {
        if (cell.effect === 15 && cell.param > 0) {
          out.push({ bpm: cell.param >= 32, value: cell.param });
        }
      }
    }
  }
  return out;
}

/** How badly a rows-per-beat value serves every speed and BPM the module uses. */
function scoreTiming(
  r: number,
  speeds: Set<number>,
  bpms: Set<number>
): { bad: number; err: number } {
  let bad = 0;
  let err = 0;
  for (const sp of speeds) {
    for (const b of bpms) {
      const t = tempoOf(sp, b, r);
      if (t < EFFECT_TEMPO_MIN || t > EFFECT_TEMPO_MAX) {
        bad += 1;
      }
      err = Math.max(err, Math.abs(Math.round(t) - t) / t);
    }
  }
  return { bad, err };
}

function chooseTiming(file: ModFile, issues: Issue[]): Timing {
  const speeds = new Set<number>([DEFAULT_SPEED]);
  const bpms = new Set<number>([DEFAULT_BPM]);
  for (const e of tempoEvents(file)) {
    (e.bpm ? bpms : speeds).add(e.value);
  }
  let best = { bad: Number.POSITIVE_INFINITY, err: 0, r: 4 };
  for (const r of R_CHOICES) {
    const score = scoreTiming(r, speeds, bpms);
    if (
      score.bad < best.bad ||
      (score.bad === best.bad && score.err + 0.0005 < best.err)
    ) {
      best = { ...score, r };
    }
    if (score.bad === 0 && score.err < 0.003) {
      best = { ...score, r };
      break;
    }
  }
  if (best.bad > 0) {
    issues.push(
      note(
        "warning",
        `some speed and tempo combinations of this module need a Bleepkit tempo outside ${EFFECT_TEMPO_MIN} to ${EFFECT_TEMPO_MAX}; those tempo changes are clamped and run slightly off`
      )
    );
  }
  return {
    bpm: DEFAULT_BPM,
    rowsPerBeat: best.r,
    speed: DEFAULT_SPEED,
    tempo: tempoOf(DEFAULT_SPEED, DEFAULT_BPM, best.r),
  };
}

/* ---------- ids ---------- */

const NON_ID = /[^a-z0-9]+/g;
const EDGE_DASH = /^-+|-+$/g;

function slug(text: string, max: number): string {
  return text
    .toLowerCase()
    .replace(NON_ID, "-")
    .replace(EDGE_DASH, "")
    .slice(0, max)
    .replace(EDGE_DASH, "");
}

/** `<song>-<nn>` plus the sample's name when it has one, at most 64 characters. */
function sampleId(prefix: string, n: number, name: string): string {
  const nn = String(n).padStart(2, "0");
  const base = `${prefix.slice(0, 36)}-${nn}`;
  const tail = slug(name, 63 - base.length);
  return tail ? `${base}-${tail}` : base;
}

/* ---------- samples ---------- */

function toUserSample(s: ModFile["samples"][number], ref: number): UserSample {
  const bytes = new Uint8Array(s.data.length);
  for (let i = 0; i < s.data.length; i += 1) {
    bytes[i] = (s.data[i] ?? 0) & 255;
  }
  const len = s.data.length;
  let loop: UserSample["loop"] = null;
  if (s.loopLength > 2 && s.loopStart < len) {
    const end = Math.min(len, s.loopStart + s.loopLength);
    if (end - s.loopStart >= 2) {
      loop = { end, start: s.loopStart };
    }
  }
  return {
    baseNote: MOD_C2_NOTE,
    bits: 8,
    data: bytesToBase64(bytes),
    finetune: s.finetune * 12.5,
    loop,
    name: (s.name || "Sample").slice(0, 64),
    rate: MOD_SAMPLE_RATE,
    version: FORMAT_VERSION,
    volume: ref / 64,
  };
}

function toInstrument(name: string, id: string): Instrument {
  const inst = defaultInstrument("sample", "amiga");
  inst.name = name.slice(0, 64);
  inst.volume = 1;
  inst.envelope = { attack: 0, decay: 0, release: 0.004, sustain: 1 };
  inst.send = { echo: 0, reverb: 0 };
  inst.sample = {
    baseNote: 60,
    generator: "pluck",
    loop: false,
    params: { brightness: 0.6, damp: 0.3, pick: 0.5 },
    seed: 1,
    userSample: id,
  };
  return inst;
}

/* ---------- the row converter ---------- */

type Family =
  | "arp"
  | "fine"
  | "porta"
  | "slide"
  | "trem"
  | "vib"
  | "vols"
  | "retrig";

const STOP: Record<Family, Effect> = {
  arp: { type: "arp", x: 0, y: 0 },
  fine: { type: "pitch", x: 8, y: 0 },
  porta: { type: "portamento", x: 0, y: 0 },
  retrig: { type: "retrigger", x: 0, y: 0 },
  slide: { type: "slideUp", x: 0, y: 0 },
  trem: { type: "tremolo", x: 0, y: 0 },
  vib: { type: "vibrato", x: 0, y: 0 },
  vols: { type: "volSlide", x: 0, y: 0 },
};

interface Chan {
  active: Set<Family>;
  /** Bleepkit's volume column as last written (0 to 15). */
  col: number;
  memOffset: number;
  memPorta: number;
  memTremDepth: number;
  memTremSpeed: number;
  memVibDepth: number;
  memVibSpeed: number;
  /** The current period (for rescaling slides), 0 before the first note. */
  period: number;
  /** Current sample number (1 based), 0 for none. */
  sample: number;
  /** ProTracker's channel volume 0 to 64. */
  vol: number;
}

function newChan(): Chan {
  return {
    active: new Set(),
    col: 15,
    memOffset: 0,
    memPorta: 0,
    memTremDepth: 0,
    memTremSpeed: 0,
    memVibDepth: 0,
    memVibSpeed: 0,
    period: 0,
    sample: 0,
    vol: 64,
  };
}

interface Counts {
  clamped: Map<string, number>;
  dropped: Map<string, number>;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

interface Ctx {
  bpm: number;
  chans: Chan[];
  counts: Counts;
  /** The module's default volume per sample number (0 to 64). */
  defaults: number[];
  /** Reference volume per sample number: the Bleepkit volume column 15 (the default volume, 64 for a silent sample). */
  ref: number[];
  speed: number;
  timing: Timing;
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** How much of a ProTracker per-tick amount a Bleepkit tick (50 Hz) carries: effect ticks are speed - 1 of speed. */
function tickScale(c: Ctx): number {
  return ((c.speed - 1) / c.speed) * (c.bpm / DEFAULT_BPM);
}

/** ProTracker ticks to Bleepkit ticks (the tick clock is fixed at 50 Hz, ProTracker's runs at BPM * 0.4). */
function ticksOf(c: Ctx, y: number): number {
  return Math.max(1, Math.round((y * DEFAULT_BPM) / c.bpm));
}

function periodOf(ch: Chan): number {
  return ch.period > 0 ? ch.period : 428;
}

/** Quantize a ProTracker volume to the volume column, relative to the sample's own volume. */
function volumeColumn(c: Ctx, ch: Chan): number {
  const ref = c.ref[ch.sample] ?? 64;
  return clamp(Math.round((ch.vol * 15) / ref), 0, 15);
}

interface RowOut {
  fx: Effect[];
  inst: string | null;
  note: number | null;
  /** ProTracker volume units per tick the row slides by (negative down), 0 for none. */
  slide: number;
  vol: number | null;
}

function put(out: RowOut, type: EffectType, byte: number): void {
  out.fx.push(effectFromByte(type, byte));
}

/** The note or tone-portamento target of a period. */
function noteOfPeriod(period: number, counts: Counts): number {
  const n = nearestNote(period);
  if (n < MOD_NOTE_LOW || n > MOD_NOTE_HIGH) {
    bump(counts.clamped, "note outside ProTracker's C-1 to B-3");
  }
  return Math.min(127, Math.max(0, n));
}

/** Bleepkit slide bytes (sixteenths of a semitone per tick) for ProTracker period units per tick. */
function slideBytes(c: Ctx, ch: Chan, units: number): number {
  return clamp(
    Math.round((units * 277.13 * tickScale(c)) / periodOf(ch)),
    1,
    255
  );
}

function vibratoFx(
  c: Ctx,
  ch: Chan,
  cell: ModCell,
  out: RowOut,
  live: Set<Family>
): void {
  const x = cell.param >> 4;
  const y = cell.param & 15;
  if (x > 0) {
    ch.memVibSpeed = x;
  }
  if (y > 0) {
    ch.memVibDepth = y;
  }
  if (ch.memVibSpeed > 0 && ch.memVibDepth > 0) {
    const sp = clamp(Math.round((ch.memVibSpeed * c.bpm) / DEFAULT_BPM), 1, 15);
    const dp = clamp(
      Math.round((ch.memVibDepth * 432.7) / periodOf(ch)),
      1,
      15
    );
    out.fx.push({ type: "vibrato", x: sp, y: dp });
    live.add("vib");
  }
}

function tremoloFx(
  c: Ctx,
  ch: Chan,
  cell: ModCell,
  out: RowOut,
  live: Set<Family>
): void {
  const x = cell.param >> 4;
  const y = cell.param & 15;
  if (x > 0) {
    ch.memTremSpeed = x;
  }
  if (y > 0) {
    ch.memTremDepth = y;
  }
  if (ch.memTremSpeed > 0 && ch.memTremDepth > 0) {
    out.fx.push({
      type: "tremolo",
      x: clamp(Math.round((ch.memTremSpeed * c.bpm) / DEFAULT_BPM), 1, 15),
      y: clamp(Math.round(ch.memTremDepth * 1.87), 1, 15),
    });
    live.add("trem");
  }
}

function volSlideFx(
  c: Ctx,
  ch: Chan,
  cell: ModCell,
  out: RowOut,
  live: Set<Family>
): void {
  const x = cell.param >> 4;
  const y = cell.param & 15;
  const ref = c.ref[ch.sample] ?? 64;
  const units = x > 0 ? x : y;
  const scale = tickScale(c);
  if (units > 0 && scale > 0) {
    const n = clamp(Math.round((units * 16 * scale) / ref), 1, 15);
    out.fx.push(
      x > 0
        ? { type: "volSlide", x: n, y: 0 }
        : { type: "volSlide", x: 0, y: n }
    );
    out.slide = x > 0 ? units : -units;
    live.add("vols");
  }
}

function portaFx(
  c: Ctx,
  ch: Chan,
  cell: ModCell,
  out: RowOut,
  live: Set<Family>
): void {
  if (cell.param > 0) {
    ch.memPorta = cell.param;
  }
  if (ch.memPorta > 0 && tickScale(c) > 0) {
    put(out, "portamento", slideBytes(c, ch, ch.memPorta));
    live.add("porta");
  }
}

function sampleOffsetFx(
  c: Ctx,
  ch: Chan,
  cell: ModCell,
  out: RowOut,
  hasNote: boolean
): void {
  if (!hasNote) {
    bump(c.counts.dropped, "9xx sample offset on a row without a note");
    return;
  }
  if (cell.param > 0) {
    ch.memOffset = cell.param;
  }
  if (ch.memOffset > 0) {
    put(out, "sampleOffset", ch.memOffset);
  }
}

/** Map the effect of one cell. Returns the families it keeps alive in Bleepkit. */
function mapEffect(
  c: Ctx,
  ch: Chan,
  cell: ModCell,
  out: RowOut,
  hasNote: boolean
): Set<Family> {
  const live = new Set<Family>();
  const x = cell.param >> 4;
  const y = cell.param & 15;
  switch (cell.effect) {
    case 0:
      if (cell.param !== 0) {
        out.fx.push({ type: "arp", x, y });
        live.add("arp");
      }
      break;
    case 1:
    case 2:
      if (cell.param > 0 && tickScale(c) > 0) {
        put(
          out,
          cell.effect === 1 ? "slideUp" : "slideDown",
          slideBytes(c, ch, cell.param)
        );
        live.add("slide");
      }
      break;
    case 3:
      portaFx(c, ch, cell, out, live);
      break;
    case 4:
      vibratoFx(c, ch, cell, out, live);
      break;
    case 5:
      portaFx(c, ch, { ...cell, param: 0 }, out, live);
      volSlideFx(c, ch, cell, out, live);
      break;
    case 6:
      vibratoFx(c, ch, { ...cell, param: 0 }, out, live);
      volSlideFx(c, ch, cell, out, live);
      break;
    case 7:
      tremoloFx(c, ch, cell, out, live);
      break;
    case 8:
      bump(c.counts.dropped, "8xx set pan (Paula channels are hard panned)");
      break;
    case 9:
      sampleOffsetFx(c, ch, cell, out, hasNote);
      break;
    case 10:
      volSlideFx(c, ch, cell, out, live);
      break;
    default:
      break;
  }
  return live;
}

function mapExtended(
  c: Ctx,
  ch: Chan,
  cell: ModCell,
  out: RowOut,
  hasNote: boolean
): Set<Family> {
  const live = new Set<Family>();
  const sub = cell.param >> 4;
  const y = cell.param & 15;
  switch (sub) {
    case 0:
      // ProTracker: E00 switches the filter on, E01 off. Bleepkit's E01 is the LED filter on.
      put(out, "filter", y === 0 ? 1 : 0);
      break;
    case 1:
    case 2: {
      const p = periodOf(ch);
      const up = sub === 1;
      const semis = up
        ? 12 * Math.log2(p / Math.max(1, p - y))
        : 12 * Math.log2((p + y) / p);
      const units = clamp(Math.round(16 * semis), 0, 127);
      if (units > 0) {
        put(out, "pitch", 128 + (up ? units : -units));
        live.add("fine");
      }
      break;
    }
    case 9:
      if (y > 0) {
        put(out, "retrigger", ticksOf(c, y));
        live.add("retrig");
      }
      break;
    case 10:
    case 11: {
      const delta = sub === 10 ? y : -y;
      ch.vol = clamp(ch.vol + delta, 0, 64);
      break;
    }
    case 12:
      put(out, "cut", y === 0 ? 1 : ticksOf(c, y));
      break;
    case 13:
      if (hasNote && y > 0) {
        put(out, "delay", ticksOf(c, y));
      }
      break;
    default:
      bump(
        c.counts.dropped,
        `E${sub.toString(16).toUpperCase()}y (${EXT_NAMES[sub] ?? "unknown"})`
      );
      break;
  }
  return live;
}

const EXT_NAMES: Record<number, string> = {
  3: "glissando control",
  4: "vibrato waveform",
  5: "set finetune",
  6: "pattern loop, the loop is played once",
  7: "tremolo waveform",
  8: "set pan",
  14: "pattern delay",
  15: "invert loop",
};

/* ---------- cells, rows, patterns ---------- */

const MAX_FX = 4;
const ROWS = 64;

function addFx(out: RowOut, fx: Effect, counts: Counts): void {
  if (out.fx.length >= MAX_FX) {
    bump(counts.dropped, "effects beyond the fourth on one row");
    return;
  }
  out.fx.push(fx);
}

/** Add stop effects for the families that lapsed, keeping a fine slide until the next note. */
function lapse(
  ch: Chan,
  live: Set<Family>,
  hasNote: boolean,
  out: RowOut,
  counts: Counts
): void {
  for (const f of ch.active) {
    if (live.has(f)) {
      continue;
    }
    if (f === "fine" && !hasNote) {
      live.add("fine");
      continue;
    }
    addFx(out, STOP[f], counts);
    if (f === "vols") {
      ch.col = -1;
    }
  }
  ch.active = live;
}

interface CellEnv {
  c: Ctx;
  /** Instrument id per sample number, null when the sample has no usable audio. */
  ids: (string | null)[];
}

/** A sample number on a cell: it becomes the channel's sample and resets its volume to the sample's own. */
function startSample(env: CellEnv, ch: Chan, cell: ModCell, out: RowOut): void {
  const { c, ids } = env;
  if (cell.sample === 0) {
    return;
  }
  ch.sample = cell.sample;
  ch.vol = c.defaults[cell.sample] ?? 64;
  out.inst = ids[cell.sample] ?? null;
  if (out.inst === null) {
    bump(c.counts.dropped, "samples with no audio");
  }
}

/** A period on a cell: the note (or the slide target), unless the channel has no usable sample. */
function startNote(env: CellEnv, ch: Chan, cell: ModCell, out: RowOut): void {
  if (cell.period === 0) {
    return;
  }
  const { c, ids } = env;
  if ((ids[ch.sample] ?? null) === null) {
    bump(c.counts.dropped, "notes before any sample or on an empty one");
  } else {
    out.note = noteOfPeriod(cell.period, c.counts);
  }
  ch.period = cell.period;
}

function mapCellEffect(
  c: Ctx,
  ch: Chan,
  cell: ModCell,
  out: RowOut
): Set<Family> {
  const hasNote = out.note !== null;
  if (cell.effect === 12) {
    ch.vol = clamp(cell.param, 0, 64);
    return new Set();
  }
  if (cell.effect === 14) {
    return mapExtended(c, ch, cell, out, hasNote);
  }
  if (cell.effect === 11 || cell.effect === 13 || cell.effect === 15) {
    return new Set();
  }
  return mapEffect(c, ch, cell, out, hasNote);
}

/** Write the volume column when the volume changed (or a sample was named). */
function writeVolume(c: Ctx, ch: Chan, cell: ModCell, out: RowOut): void {
  const sub = cell.param >> 4;
  const edit =
    cell.effect === 12 || (cell.effect === 14 && (sub === 10 || sub === 11));
  if (!(out.inst !== null || out.note !== null || edit || ch.col < 0)) {
    return;
  }
  const col = volumeColumn(c, ch);
  if (out.inst !== null || col !== ch.col) {
    out.vol = col;
  }
  ch.col = col;
}

function convertCell(env: CellEnv, ch: Chan, cell: ModCell): Row {
  const { c } = env;
  const out: RowOut = { fx: [], inst: null, note: null, slide: 0, vol: null };
  startSample(env, ch, cell, out);
  startNote(env, ch, cell, out);
  const live = mapCellEffect(c, ch, cell, out);
  lapse(ch, live, out.note !== null, out, c.counts);
  writeVolume(c, ch, cell, out);
  if (out.slide !== 0) {
    ch.vol = clamp(ch.vol + out.slide * (c.speed - 1), 0, 64);
  }
  return { fx: out.fx, inst: out.inst, note: out.note, row: 0, vol: out.vol };
}

/** Tempo change of one row: speed and BPM are applied to every channel in order, the last F wins for each. */
function applyTempo(
  c: Ctx,
  cells: ModCell[]
): { chan: number; fx: Effect } | null {
  let chan = -1;
  let halt = false;
  cells.forEach((cell, i) => {
    if (cell.effect !== 15) {
      return;
    }
    chan = i;
    if (cell.param === 0) {
      halt = true;
    } else if (cell.param >= 32) {
      c.bpm = cell.param;
    } else {
      c.speed = cell.param;
    }
  });
  if (chan < 0) {
    return null;
  }
  if (halt) {
    return { chan, fx: { type: "halt", x: 0, y: 0 } };
  }
  const t = tempoOf(c.speed, c.bpm, c.timing.rowsPerBeat);
  if (t < EFFECT_TEMPO_MIN || t > EFFECT_TEMPO_MAX) {
    bump(
      c.counts.clamped,
      `tempo outside ${EFFECT_TEMPO_MIN} to ${EFFECT_TEMPO_MAX} BPM`
    );
  }
  return {
    chan,
    fx: effectFromByte(
      "tempo",
      clamp(Math.round(t), EFFECT_TEMPO_MIN, EFFECT_TEMPO_MAX)
    ),
  };
}

interface ConvertedPattern {
  length: number;
  tracks: Record<string, Row[]>;
}

/** The flow effect of a cell (jump or skip), or null. */
function flowEffect(c: Ctx, cell: ModCell, songLength: number): Effect | null {
  if (cell.effect === 11) {
    if (cell.param < songLength) {
      return effectFromByte("jump", cell.param);
    }
    bump(c.counts.dropped, "Bxx jumps past the end of the order list");
    return null;
  }
  if (cell.effect === 13) {
    return effectFromByte("skip", (cell.param >> 4) * 10 + (cell.param & 15));
  }
  return null;
}

interface RowEnv {
  channelIds: string[];
  songLength: number;
  tempo: { chan: number; fx: Effect } | null;
  tracks: Record<string, Row[]>;
}

/** One channel's cell of a row, with the row's tempo and flow effects on it. Returns whether the row flow stops here. */
function convertChannel(
  env: CellEnv,
  re: RowEnv,
  i: number,
  r: number,
  cell: ModCell
): boolean {
  const { c } = env;
  const ch = c.chans[i];
  const id = re.channelIds[i];
  if (!(ch && id !== undefined)) {
    return false;
  }
  const row = convertCell(env, ch, cell);
  if (re.tempo?.chan === i) {
    row.fx.unshift(re.tempo.fx);
  }
  const flow = flowEffect(c, cell, re.songLength);
  if (flow) {
    row.fx.unshift(flow);
  }
  if (row.fx.length > MAX_FX) {
    bump(c.counts.dropped, "effects beyond the fourth on one row");
    row.fx.length = MAX_FX;
  }
  if (
    row.note !== null ||
    row.inst !== null ||
    row.vol !== null ||
    row.fx.length > 0
  ) {
    row.row = r;
    const list = re.tracks[id] ?? [];
    list.push(row);
    re.tracks[id] = list;
  }
  return cell.effect === 11 || cell.effect === 13;
}

function convertPattern(
  env: CellEnv,
  src: ModCell[][],
  channelIds: string[],
  songLength: number
): ConvertedPattern {
  const tracks: Record<string, Row[]> = {};
  for (let r = 0; r < ROWS; r += 1) {
    const cells = src[r] ?? [];
    const tempo = applyTempo(env.c, cells);
    const re: RowEnv = { channelIds, songLength, tempo, tracks };
    let stop = tempo?.fx.type === "halt";
    for (let i = 0; i < channelIds.length; i += 1) {
      const cell = cells[i];
      if (cell && convertChannel(env, re, i, r, cell)) {
        stop = true;
      }
    }
    if (stop) {
      return { length: r + 1, tracks };
    }
  }
  return { length: ROWS, tracks };
}

/* ---------- the whole module ---------- */

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? `${n} ${one}` : `${n} ${many}`;
}

function summarize(map: Map<string, number>): string {
  return [...map.entries()].map(([k, v]) => `${k} (${v}x)`).join(", ");
}

/** Samples that some cell of a played pattern refers to. */
function usedSamples(file: ModFile): Set<number> {
  const used = new Set<number>();
  for (const p of new Set(file.order)) {
    for (const row of file.patterns[p] ?? []) {
      for (const cell of row) {
        if (cell.sample > 0) {
          used.add(cell.sample);
        }
      }
    }
  }
  return used;
}

function paulaPans(n: number, separation: number): number[] {
  const hard = [-1, 1, 1, -1];
  return Array.from({ length: n }, (_, i) => (hard[i % 4] ?? 0) * separation);
}

interface Library {
  defaults: number[];
  ids: (string | null)[];
  instruments: Record<string, Instrument>;
  ref: number[];
  samples: Record<string, UserSample>;
}

/** The used samples as user samples and instruments, with the per sample-number tables the converter needs. */
function buildLibrary(file: ModFile, id: string): Library {
  const used = usedSamples(file);
  const lib: Library = {
    defaults: [0],
    ids: [null],
    instruments: {},
    ref: [64],
    samples: {},
  };
  for (let n = 1; n <= 31; n += 1) {
    const s = file.samples[n - 1];
    const vol = s?.volume ?? 0;
    lib.defaults.push(vol);
    lib.ref.push(vol > 0 ? vol : 64);
    if (s && used.has(n) && s.data.length >= 2) {
      const sid = sampleId(id, n, s.name);
      lib.samples[sid] = toUserSample(s, vol > 0 ? vol : 64);
      lib.instruments[sid] = toInstrument(s.name || `Sample ${n}`, sid);
      lib.ids.push(sid);
    } else {
      lib.ids.push(null);
    }
  }
  return lib;
}

/** Every order entry converted, equal patterns stored once. */
function buildOrder(
  env: CellEnv,
  file: ModFile,
  channelIds: string[]
): { order: string[]; patterns: Record<string, Pattern> } {
  const patterns: Record<string, Pattern> = {};
  const byContent = new Map<string, string>();
  const order: string[] = [];
  for (const slot of file.order) {
    const conv = convertPattern(
      env,
      file.patterns[slot] ?? [],
      channelIds,
      file.songLength
    );
    const key = JSON.stringify(conv);
    let pid = byContent.get(key);
    if (pid === undefined) {
      pid = `p${String(byContent.size + 1).padStart(2, "0")}`;
      byContent.set(key, pid);
      patterns[pid] = conv;
    }
    order.push(pid);
  }
  return { order, patterns };
}

function loopOf(file: ModFile, opts: ModToSongOptions): number | null {
  if (opts.loop === false) {
    return null;
  }
  return file.restart < file.songLength ? file.restart : 0;
}

/** The empty song for the module's chip: the Paula output settings, or Paula-like pans on the custom chip. */
function songShell(
  file: ModFile,
  channelIds: string[],
  separation: number
): Song {
  if (file.channels === 4) {
    const song = defaultSong("amiga");
    song.master.amiga = { led: false, model: "a500", separation };
    return song;
  }
  const song = defaultSong("custom");
  const pans = paulaPans(channelIds.length, separation);
  song.channels = channelIds.map((cid, i) => ({
    id: cid,
    instrument: null,
    kind: "sample" as const,
    mml: null,
    muted: false,
    pan: pans[i] ?? 0,
    volume: 1,
  }));
  return song;
}

function customNotice(file: ModFile): Issue[] {
  if (file.channels === 4) {
    return [];
  }
  const cut =
    file.channels > CUSTOM_MAX_CHANNELS
      ? ` (the first ${CUSTOM_MAX_CHANNELS} are kept)`
      : "";
  return [
    note(
      "info",
      `${file.tag} has ${file.channels} channels and Paula has 4, so the song uses the custom chip with sample channels panned like Paula${cut}; Paula's period steps and output filters do not apply`
    ),
  ];
}

function countIssues(counts: Counts): Issue[] {
  const out: Issue[] = [];
  if (counts.dropped.size > 0) {
    out.push(note("warning", `not converted: ${summarize(counts.dropped)}`));
  }
  if (counts.clamped.size > 0) {
    out.push(note("warning", `changed to fit: ${summarize(counts.clamped)}`));
  }
  return out;
}

/** Read a ProTracker module (the bytes of a .mod file) and build the Bleepkit song, instruments and samples. */
export function modToSong(
  bytes: Uint8Array,
  opts: ModToSongOptions = {}
): ModImport {
  const { file, issues: parseIssues } = parseMod(bytes);
  if (!file) {
    return {
      info: null,
      instruments: {},
      issues: parseIssues,
      samples: {},
      song: defaultSong("amiga"),
    };
  }
  const issues: Issue[] = [...parseIssues, ...customNotice(file)];
  const id = slug(opts.id ?? "mod", 36) || "mod";
  const channelCount = Math.min(file.channels, CUSTOM_MAX_CHANNELS);
  const timing = chooseTiming(file, issues);
  const lib = buildLibrary(file, id);
  const ctx: Ctx = {
    bpm: DEFAULT_BPM,
    chans: Array.from({ length: channelCount }, newChan),
    counts: { clamped: new Map(), dropped: new Map() },
    defaults: lib.defaults,
    ref: lib.ref,
    speed: DEFAULT_SPEED,
    timing,
  };
  const song = songShell(
    file,
    Array.from({ length: channelCount }, (_, i) => `ch${i + 1}`),
    clamp(opts.separation ?? 1, 0, 1)
  );
  const channelIds = song.channels.map((ch) => ch.id);
  const built = buildOrder({ c: ctx, ids: lib.ids }, file, channelIds);
  song.name = ((opts.name ?? file.title) || id).slice(0, 64);
  song.tempo = Math.round(timing.tempo * 100) / 100;
  song.rowsPerBeat = timing.rowsPerBeat;
  song.tickRate = TICK_RATE;
  song.patterns = built.patterns;
  song.order = built.order;
  song.loop = loopOf(file, opts);
  issues.push(...countIssues(ctx.counts));
  const info: ModInfo = {
    bpm: DEFAULT_BPM,
    channels: file.channels,
    orderLength: file.songLength,
    patternsUsed: Object.keys(built.patterns).length,
    rowsPerBeat: timing.rowsPerBeat,
    samplesUsed: Object.keys(lib.samples).length,
    speed: DEFAULT_SPEED,
    tag: file.tag,
    tempo: song.tempo,
    title: file.title,
  };
  issues.push(
    note(
      "info",
      `${file.tag} "${file.title}": ${plural(file.songLength, "order entry", "order entries")}, ${plural(info.patternsUsed, "pattern")} after merging equal ones, ${plural(info.samplesUsed, "sample")}; ${timing.rowsPerBeat} rows per beat at tempo ${song.tempo}`
    )
  );
  const checked = normalizeSong(song, lib.instruments, lib.samples);
  issues.push(...checked.issues.filter((i) => i.severity !== "info"));
  return {
    info,
    instruments: lib.instruments,
    issues,
    samples: lib.samples,
    song: checked.value,
  };
}
