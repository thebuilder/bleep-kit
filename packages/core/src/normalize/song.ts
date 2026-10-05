import { CUSTOM_MAX_CHANNELS } from "../chips/custom.ts";
import { CHIPS } from "../chips/index.ts";
import { parseMml } from "../mml/parser.ts";
import { parseNoteName } from "../notes.ts";
import type {
  ChannelKind,
  ChipId,
  ChipProfile,
  Effect,
  Instrument,
  Normalized,
  NoteValue,
  Pattern,
  Row,
  Song,
  SongChannel,
  SongMaster,
} from "../types.ts";
import {
  CHANNEL_KINDS,
  CHIP_IDS,
  EFFECT_TYPES,
  FORMAT_VERSION,
  PPQ,
} from "../types.ts";
import { defaultSong } from "./defaults.ts";
import {
  effectByte,
  effectFromByte,
  parseEffect,
  parseRowString,
} from "./effects.ts";
import type { Ctx, Rec } from "./issues.ts";
import {
  clampNum,
  dropUnknown,
  enumField,
  error,
  finish,
  ID_RE,
  isRec,
  newCtx,
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

const SONG_KEYS = [
  "id",
  "version",
  "name",
  "chip",
  "tempo",
  "rowsPerBeat",
  "tickRate",
  "channels",
  "patterns",
  "order",
  "loop",
  "master",
];
const CHANNEL_KEYS = [
  "id",
  "kind",
  "instrument",
  "volume",
  "pan",
  "mml",
  "muted",
];
const ROW_KEYS = ["row", "note", "inst", "vol", "fx", "s"];
const MIN_TEMPO_BYTE = 0x20;
const SYNTH_PATTERN_BEATS = 4;
const SYNTH_ID_RE = /^mml-\d+$/;

interface ChannelInfo {
  id: string;
  /** Index in the input array, for issue paths. */
  index: number;
  kind: ChannelKind;
  mml: string | null;
}

interface Refs {
  /** Instrument ids referenced anywhere, with the first path that referenced each. */
  used: Map<string, string>;
}

function fixedKindCheck(
  ctx: Ctx,
  path: string,
  id: string,
  channel: ChannelInfo,
  chip: ChipId,
  instruments: Record<string, Instrument> | undefined,
  refs: Refs
): void {
  if (!refs.used.has(id)) {
    refs.used.set(id, path);
  }
  if (!instruments) {
    return;
  }
  const inst = instruments[id];
  if (!inst) {
    error(ctx, path, `instrument "${id}" does not exist`);
    return;
  }
  if (chip !== "custom" && inst.kind !== channel.kind) {
    error(
      ctx,
      path,
      `instrument "${id}" is kind "${inst.kind}" but channel "${channel.id}" is "${channel.kind}"`
    );
  }
}

interface ChannelList {
  channels: SongChannel[];
  infos: ChannelInfo[];
}

/** The chip's default channels, used when the document has none that survive validation. */
function defaultChannels(chip: ChipId): ChannelList {
  const channels: SongChannel[] = [];
  const infos: ChannelInfo[] = [];
  for (const [i, c] of defaultSong(chip).channels.entries()) {
    channels.push(c);
    infos.push({ id: c.id, kind: c.kind, index: i, mml: null });
  }
  return { channels, infos };
}

/** The channel id: 1 to 32 characters. Null (with an error) when it is missing or malformed. */
function readChannelId(ctx: Ctx, c: Rec, p: string): string | null {
  const { id } = c;
  if (typeof id === "string" && id.length > 0 && id.length <= 32) {
    return id;
  }
  error(
    ctx,
    ptr(p, "id"),
    id === undefined
      ? "is required"
      : `must be a string of 1 to 32 characters (was ${show(id)})`
  );
  return null;
}

/**
 * The kind of a channel: free on a custom chip (up to CUSTOM_MAX_CHANNELS of them), fixed by the hardware
 * otherwise. Null (with an error) when the channel has to be dropped.
 */
function resolveChannelKind(
  ctx: Ctx,
  c: Rec,
  id: string,
  p: string,
  chip: ChipId,
  profile: ChipProfile,
  keptCount: number
): ChannelKind | null {
  if (chip === "custom") {
    const kind = enumField(ctx, c, "kind", p, CHANNEL_KINDS, "pulse", true);
    if (keptCount >= CUSTOM_MAX_CHANNELS) {
      error(
        ctx,
        p,
        `a custom song has at most ${CUSTOM_MAX_CHANNELS} channels, "${id}" was dropped`
      );
      return null;
    }
    return kind;
  }
  const hw = profile.channels.find((x) => x.id === id);
  if (!hw) {
    error(
      ctx,
      ptr(p, "id"),
      `unknown channel "${id}" for chip "${chip}" (it has ${profile.channels.map((x) => x.id).join(", ")})`
    );
    return null;
  }
  if (c.kind !== undefined && c.kind !== hw.kind) {
    warn(
      ctx,
      ptr(p, "kind"),
      `kind ${show(c.kind)} does not match channel "${id}", using "${hw.kind}"`
    );
  }
  return hw.kind;
}

/** The channel's instrument id, checked against the instruments when they are known. */
function readChannelInstrument(
  ctx: Ctx,
  c: Rec,
  p: string,
  info: ChannelInfo,
  chip: ChipId,
  instruments: Record<string, Instrument> | undefined,
  refs: Refs
): string | null {
  const raw = c.instrument;
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string" || !ID_RE.test(raw)) {
    error(
      ctx,
      ptr(p, "instrument"),
      `must be an instrument id of lowercase letters, digits and dashes (was ${show(raw)})`
    );
    return null;
  }
  fixedKindCheck(ctx, ptr(p, "instrument"), raw, info, chip, instruments, refs);
  return raw;
}

/** The channel's MML text; blank text counts as none. */
function readChannelMml(ctx: Ctx, c: Rec, p: string): string | null {
  const { mml } = c;
  if (mml === undefined || mml === null) {
    return null;
  }
  if (typeof mml !== "string") {
    error(ctx, ptr(p, "mml"), `must be a string or null (was ${show(mml)})`);
    return null;
  }
  return mml.trim().length > 0 ? mml : null;
}

function readChannels(
  ctx: Ctx,
  doc: Rec,
  chip: ChipId,
  profile: ChipProfile,
  instruments: Record<string, Instrument> | undefined,
  refs: Refs
): ChannelList {
  const raw = doc.channels;
  if (raw === undefined) {
    return defaultChannels(chip);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    error(
      ctx,
      "/channels",
      Array.isArray(raw)
        ? "must have at least 1 channel"
        : `must be an array of channels (was ${show(raw)})`
    );
    return defaultChannels(chip);
  }
  const channels: SongChannel[] = [];
  const infos: ChannelInfo[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const p = ptr("/channels", i);
    const c = raw[i];
    if (!isRec(c)) {
      error(ctx, p, `must be an object (was ${show(c)})`);
      continue;
    }
    dropUnknown(ctx, c, p, CHANNEL_KEYS);
    const id = readChannelId(ctx, c, p);
    if (id === null) {
      continue;
    }
    const kind = resolveChannelKind(
      ctx,
      c,
      id,
      p,
      chip,
      profile,
      channels.length
    );
    if (kind === null) {
      continue;
    }
    if (seen.has(id)) {
      error(
        ctx,
        ptr(p, "id"),
        `channel "${id}" is listed twice, the duplicate was dropped`
      );
      continue;
    }
    seen.add(id);
    const info: ChannelInfo = { id, kind, index: i, mml: null };
    const instrument = readChannelInstrument(
      ctx,
      c,
      p,
      info,
      chip,
      instruments,
      refs
    );
    const mml = readChannelMml(ctx, c, p);
    info.mml = mml;
    infos.push(info);
    channels.push({
      id,
      kind,
      instrument,
      volume: numField(ctx, c, "volume", p, { min: 0, max: 1, def: 1 }),
      pan: numField(ctx, c, "pan", p, { min: -1, max: 1, def: 0 }),
      mml,
      muted:
        c.muted === undefined
          ? false
          : readMuted(ctx, c.muted, ptr(p, "muted")),
    });
  }
  return channels.length === 0 ? defaultChannels(chip) : { channels, infos };
}

function readMuted(ctx: Ctx, v: unknown, path: string): boolean {
  if (typeof v !== "boolean") {
    error(ctx, path, `must be true or false (was ${show(v)})`);
    return false;
  }
  return v;
}

function readNote(ctx: Ctx, v: unknown, path: string): NoteValue | null {
  if (v === undefined || v === null) {
    return null;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return clampNum(ctx, v, path, { min: 0, max: 127, int: true });
  }
  if (typeof v === "string") {
    const up = v.toUpperCase();
    if (up === "OFF") {
      return "off";
    }
    if (up === "REL" || up === "RELEASE") {
      return "release";
    }
    if (v === "..." || v === "") {
      return null;
    }
    const n = parseNoteName(v);
    if (n !== null) {
      return n;
    }
  }
  error(
    ctx,
    path,
    `must be a note number 0 to 127, a note name like C-4, "off" or "release" (was ${show(v)})`
  );
  return null;
}

function readEffect(ctx: Ctx, v: unknown, path: string): Effect | null {
  if (typeof v === "string") {
    const e = parseEffect(v);
    if (!e) {
      error(
        ctx,
        path,
        `"${v}" is not an effect code (a letter then two hex digits, like A0F)`
      );
      return null;
    }
    return e;
  }
  if (!isRec(v)) {
    error(
      ctx,
      path,
      `must be an effect code or { type, x, y } (was ${show(v)})`
    );
    return null;
  }
  dropUnknown(ctx, v, path, ["type", "x", "y"]);
  const type = EFFECT_TYPES.find((t) => t === v.type);
  if (type === undefined) {
    error(
      ctx,
      ptr(path, "type"),
      `must be one of ${EFFECT_TYPES.join(", ")} (was ${show(v.type)})`
    );
    return null;
  }
  return {
    type,
    x: numField(ctx, v, "x", path, { min: 0, max: 15, int: true, def: 0 }),
    y: numField(ctx, v, "y", path, { min: 0, max: 15, int: true, def: 0 }),
  };
}

function finishEffects(ctx: Ctx, fx: Effect[], path: string): Effect[] {
  const out: Effect[] = [];
  for (const [k, e] of fx.entries()) {
    if (e.type === "tempo" && effectByte(e) < MIN_TEMPO_BYTE) {
      warn(
        ctx,
        ptr(ptr(path, "fx"), k),
        `tempo must be 32 to 255 BPM (was ${effectByte(e)}), set to 32`
      );
      out.push(effectFromByte("tempo", MIN_TEMPO_BYTE));
    } else {
      out.push(e);
    }
  }
  return out;
}

interface RowContext {
  channel: ChannelInfo;
  chip: ChipId;
  instruments: Record<string, Instrument> | undefined;
  refs: Refs;
  rowPaths: WeakMap<Row, string>;
}

function readRowInst(ctx: Ctx, v: unknown, path: string): string | null {
  if (v === undefined || v === null) {
    return null;
  }
  if (typeof v === "string") {
    return v;
  }
  error(ctx, path, `must be an instrument id or null (was ${show(v)})`);
  return null;
}

function readRowVol(ctx: Ctx, v: unknown, path: string): number | null {
  if (v === undefined || v === null) {
    return null;
  }
  if (typeof v !== "number" || !Number.isFinite(v)) {
    error(ctx, path, `must be a number 0 to 15 or null (was ${show(v)})`);
    return null;
  }
  return clampNum(ctx, v, path, { min: 0, max: 15, int: true });
}

/** The effects of a typed row: at most 4, each a code string or a { type, x, y } object. */
function readRowFx(ctx: Ctx, v: unknown, path: string): Effect[] {
  if (v === undefined) {
    return [];
  }
  if (!Array.isArray(v)) {
    error(ctx, path, `must be an array of effects (was ${show(v)})`);
    return [];
  }
  let list: unknown[] = v;
  if (list.length > 4) {
    warn(
      ctx,
      path,
      `a row holds at most 4 effects (had ${list.length}), extra effects were dropped`
    );
    list = list.slice(0, 4);
  }
  const out: Effect[] = [];
  for (const [k, f] of list.entries()) {
    const e = readEffect(ctx, f, ptr(path, k));
    if (e) {
      out.push(e);
    }
  }
  return out;
}

/** A row written as separate fields: note, inst, vol and fx. */
function readFieldsRow(
  ctx: Ctx,
  entry: Rec,
  path: string,
  rowNum: number
): Row {
  return {
    row: rowNum,
    note: readNote(ctx, entry.note, ptr(path, "note")),
    inst: readRowInst(ctx, entry.inst, ptr(path, "inst")),
    vol: readRowVol(ctx, entry.vol, ptr(path, "vol")),
    fx: readRowFx(ctx, entry.fx, ptr(path, "fx")),
  };
}

/** A row written as the compact string "C-4 lead vF A0F"; the separate fields next to it are ignored. */
function readStringRow(
  ctx: Ctx,
  entry: Rec,
  path: string,
  rowNum: number
): Row {
  let row: Row = { row: rowNum, note: null, inst: null, vol: null, fx: [] };
  if (typeof entry.s === "string") {
    const parsed = parseRowString(entry.s, rowNum);
    for (const i of parsed.issues) {
      ctx.issues.push({
        severity: i.severity,
        path: i.path === "/s" ? ptr(path, "s") : `${path}${i.path}`,
        message: i.message,
      });
    }
    ({ row } = parsed);
  } else {
    error(
      ctx,
      ptr(path, "s"),
      `must be a row string like "C-4 lead vF" (was ${show(entry.s)})`
    );
  }
  for (const k of ["note", "inst", "vol", "fx"]) {
    if (entry[k] !== undefined) {
      warn(ctx, ptr(path, k), `is ignored because "s" is set`);
    }
  }
  return row;
}

/** The row number: a whole number from 0 below the pattern length. Null (with an error) otherwise. */
function readRowNumber(
  ctx: Ctx,
  entry: Rec,
  path: string,
  length: number
): number | null {
  const rowNum = entry.row;
  if (typeof rowNum !== "number" || !Number.isInteger(rowNum) || rowNum < 0) {
    error(
      ctx,
      ptr(path, "row"),
      rowNum === undefined
        ? "is required"
        : `must be a whole number from 0 (was ${show(rowNum)})`
    );
    return null;
  }
  if (rowNum >= length) {
    error(
      ctx,
      ptr(path, "row"),
      `must be below the pattern length ${length} (was ${rowNum})`
    );
    return null;
  }
  return rowNum;
}

function readRow(
  ctx: Ctx,
  entry: unknown,
  path: string,
  length: number,
  rc: RowContext
): Row | null {
  if (!isRec(entry)) {
    error(ctx, path, `must be a row object (was ${show(entry)})`);
    return null;
  }
  dropUnknown(ctx, entry, path, ROW_KEYS);
  const rowNum = readRowNumber(ctx, entry, path, length);
  if (rowNum === null) {
    return null;
  }
  const row =
    entry.s === undefined
      ? readFieldsRow(ctx, entry, path, rowNum)
      : readStringRow(ctx, entry, path, rowNum);
  if (row.inst !== null) {
    if (ID_RE.test(row.inst)) {
      fixedKindCheck(
        ctx,
        ptr(path, "inst"),
        row.inst,
        rc.channel,
        rc.chip,
        rc.instruments,
        rc.refs
      );
    } else {
      error(
        ctx,
        ptr(path, "inst"),
        `must be an instrument id of lowercase letters, digits and dashes (was ${show(row.inst)})`
      );
      row.inst = null;
    }
  }
  row.fx = finishEffects(ctx, row.fx, path);
  rc.rowPaths.set(row, path);
  return row;
}

/** The rows of one track: invalid and duplicate rows dropped, the rest sorted by row number. */
function readTrackRows(
  ctx: Ctx,
  rowsRaw: unknown[],
  path: string,
  length: number,
  rc: RowContext
): Row[] {
  const rows: Row[] = [];
  const seenRows = new Set<number>();
  let sorted = true;
  for (let r = 0; r < rowsRaw.length; r += 1) {
    const row = readRow(ctx, rowsRaw[r], ptr(path, r), length, rc);
    if (!row) {
      continue;
    }
    if (seenRows.has(row.row)) {
      error(
        ctx,
        ptr(ptr(path, r), "row"),
        `row ${row.row} is listed twice, the duplicate was dropped`
      );
      continue;
    }
    seenRows.add(row.row);
    const last = rows.at(-1);
    if (last && last.row > row.row) {
      sorted = false;
    }
    rows.push(row);
  }
  if (!sorted) {
    warn(ctx, path, "rows must be sorted by row, they were sorted");
    rows.sort((a, b) => a.row - b.row);
  }
  return rows;
}

/** What reading a pattern's tracks needs to know about the song around it. */
interface PatternEnv {
  chip: ChipId;
  infos: ChannelInfo[];
  instruments: Record<string, Instrument> | undefined;
  refs: Refs;
  rowPaths: WeakMap<Row, string>;
}

function readPattern(ctx: Ctx, p: string, praw: Rec, env: PatternEnv): Pattern {
  dropUnknown(ctx, praw, p, ["length", "tracks"]);
  const length = numField(ctx, praw, "length", p, {
    min: 1,
    max: 256,
    int: true,
    def: 64,
  });
  const tracksRaw = section(ctx, praw, "tracks", p);
  const tracks: Record<string, Row[]> = {};
  for (const [chId, rowsRaw] of Object.entries(tracksRaw)) {
    const tp = ptr(ptr(p, "tracks"), chId);
    const info = env.infos.find((c) => c.id === chId);
    if (!info) {
      warn(
        ctx,
        tp,
        `unknown field "${chId}" was dropped (no channel with that id)`
      );
      continue;
    }
    if (!Array.isArray(rowsRaw)) {
      error(ctx, tp, `must be an array of rows (was ${show(rowsRaw)})`);
      continue;
    }
    const rc: RowContext = {
      chip: env.chip,
      channel: info,
      instruments: env.instruments,
      refs: env.refs,
      rowPaths: env.rowPaths,
    };
    const rows = readTrackRows(ctx, rowsRaw, tp, length, rc);
    if (info.mml !== null && rows.length > 0) {
      warn(ctx, tp, `is ignored because channel "${chId}" has MML`);
    }
    tracks[chId] = rows;
  }
  return { length, tracks };
}

function readPatterns(
  ctx: Ctx,
  doc: Rec,
  env: PatternEnv
): Record<string, Pattern> {
  const raw = doc.patterns;
  const out: Record<string, Pattern> = {};
  if (raw === undefined) {
    return out;
  }
  if (!isRec(raw)) {
    error(ctx, "/patterns", `must be an object of patterns (was ${show(raw)})`);
    return out;
  }
  for (const [pid, praw] of Object.entries(raw)) {
    const p = ptr("/patterns", pid);
    if (pid.length === 0 || pid.length > 64) {
      error(ctx, p, "pattern ids must be 1 to 64 characters");
    } else if (isRec(praw)) {
      out[pid] = readPattern(ctx, p, praw, env);
    } else {
      error(ctx, p, `must be an object (was ${show(praw)})`);
    }
  }
  return out;
}

/** True for an MML-only song: patterns are only the synthesized structure ("mml-1", "mml-2", ...) with no rows,
    so the MML defines the song length and loop. */
export function isMmlOnly(song: Pick<Song, "channels" | "patterns">): boolean {
  const ids = Object.keys(song.patterns);
  return (
    song.channels.some((c) => c.mml !== null) &&
    !hasAnyRows(song.patterns) &&
    (ids.length === 0 || ids.every((k) => SYNTH_ID_RE.test(k)))
  );
}

function hasAnyRows(patterns: Record<string, Pattern>): boolean {
  return Object.values(patterns).some((pat) =>
    Object.values(pat.tracks).some((rows) => rows.length > 0)
  );
}

function readEcho(ctx: Ctx, v: unknown): SongMaster["echo"] {
  if (v === undefined || v === null) {
    return null;
  }
  if (!isRec(v)) {
    error(ctx, "/master/echo", `must be an object or null (was ${show(v)})`);
    return null;
  }
  dropUnknown(ctx, v, "/master/echo", [
    "delay",
    "feedback",
    "level",
    "lowpassHz",
  ]);
  return {
    delay: numField(ctx, v, "delay", "/master/echo", {
      min: 0.01,
      max: 1,
      def: 0.25,
    }),
    feedback: numField(ctx, v, "feedback", "/master/echo", {
      min: 0,
      max: 0.95,
      def: 0.35,
    }),
    level: numField(ctx, v, "level", "/master/echo", {
      min: 0,
      max: 1,
      def: 0.3,
    }),
    lowpassHz: numField(ctx, v, "lowpassHz", "/master/echo", {
      min: 100,
      max: 20_000,
      def: 4000,
    }),
  };
}

function readReverb(ctx: Ctx, v: unknown): SongMaster["reverb"] {
  if (v === undefined || v === null) {
    return null;
  }
  if (!isRec(v)) {
    error(ctx, "/master/reverb", `must be an object or null (was ${show(v)})`);
    return null;
  }
  dropUnknown(ctx, v, "/master/reverb", ["size", "damping", "level"]);
  return {
    size: numField(ctx, v, "size", "/master/reverb", {
      min: 0,
      max: 1,
      def: 0.5,
    }),
    damping: numField(ctx, v, "damping", "/master/reverb", {
      min: 0,
      max: 1,
      def: 0.5,
    }),
    level: numField(ctx, v, "level", "/master/reverb", {
      min: 0,
      max: 1,
      def: 0.25,
    }),
  };
}

function nearestBoundary(starts: number[], pulse: number): number {
  let best = 0;
  for (let i = 1; i < starts.length; i += 1) {
    const cur = starts[i] ?? 0;
    const prev = starts[best] ?? 0;
    if (Math.abs(cur - pulse) < Math.abs(prev - pulse) - 1e-9) {
      best = i;
    }
  }
  return best;
}

/** What the channels' MML says about the song as a whole. */
interface MmlSummary {
  any: boolean;
  /** Pulse where the longest channel ends. */
  end: number;
  /** Pulse of the first L command in any channel. */
  loop: number | null;
  /** The first t command in any channel. */
  tempo: number | null;
}

/** Parse every MML channel once, for its issues, tempo, loop point and length, and the instruments it uses. */
function summarizeMml(
  ctx: Ctx,
  infos: ChannelInfo[],
  chip: ChipId,
  instruments: Record<string, Instrument> | undefined,
  refs: Refs
): MmlSummary {
  const sum: MmlSummary = { any: false, end: 0, loop: null, tempo: null };
  for (const info of infos) {
    if (info.mml === null) {
      continue;
    }
    sum.any = true;
    const path = ptr(ptr("/channels", info.index), "mml");
    const parsed = parseMml(info.mml);
    for (const i of parsed.issues) {
      ctx.issues.push({ severity: i.severity, path, message: i.message });
    }
    sum.end = Math.max(sum.end, parsed.endPulse);
    sum.tempo ??= parsed.tempo;
    sum.loop ??= parsed.loopPulse;
    for (const e of parsed.events) {
      if (e.type === "inst") {
        fixedKindCheck(ctx, path, e.id, info, chip, instruments, refs);
      }
    }
  }
  return sum;
}

/** The patterns and order of an MML-only song: empty patterns of SYNTH_PATTERN_BEATS beats that give it its length. */
function synthesizeStructure(
  mmlEnd: number,
  rowsPerBeat: number
): { order: string[]; patterns: Record<string, Pattern> } {
  const patterns: Record<string, Pattern> = {};
  const order: string[] = [];
  const perPattern = SYNTH_PATTERN_BEATS * rowsPerBeat;
  const total = Math.max(mmlEnd, 1);
  const count = Math.min(
    256,
    Math.max(1, Math.ceil(total / (SYNTH_PATTERN_BEATS * PPQ) - 1e-9))
  );
  for (let k = 0; k < count; k += 1) {
    const pid = `mml-${k + 1}`;
    patterns[pid] = { length: perPattern, tracks: {} };
    order.push(pid);
  }
  return { order, patterns };
}

/** The order list when the document's own is empty or missing: every pattern, or the first one. */
function fallbackOrder(
  ctx: Ctx,
  doc: Rec,
  patterns: Record<string, Pattern>
): string[] {
  const ids = Object.keys(patterns);
  if (ids.length === 0) {
    patterns["pattern-1"] = { length: 64, tracks: {} };
    ids.push("pattern-1");
  }
  if (Array.isArray(doc.order) && doc.order.length === 0) {
    error(ctx, "/order", "must list at least 1 pattern");
  }
  return doc.order === undefined ? ids : [ids[0] ?? "pattern-1"];
}

/**
 * The loop order index. The MML loop point wins over the document's `loop`: in a synthesized song it picks the
 * pattern it falls in, otherwise it is snapped to the nearest order boundary (with a warning when that moves it).
 */
function resolveLoop(
  ctx: Ctx,
  doc: Rec,
  structure: {
    order: string[];
    patterns: Record<string, Pattern>;
    synthesized: boolean;
  },
  pulsesPerRow: number,
  mmlLoop: number | null
): number | null {
  const { order, patterns, synthesized } = structure;
  const loop = readLoop(ctx, doc, order.length);
  if (mmlLoop === null) {
    return loop;
  }
  if (synthesized) {
    return Math.min(
      order.length - 1,
      Math.floor(mmlLoop / (SYNTH_PATTERN_BEATS * PPQ) + 1e-9)
    );
  }
  const starts: number[] = [0];
  for (const pid of order) {
    starts.push(
      (starts.at(-1) ?? 0) + (patterns[pid]?.length ?? 0) * pulsesPerRow
    );
  }
  const idx = nearestBoundary(starts.slice(0, order.length), mmlLoop);
  const exact = Math.abs((starts[idx] ?? 0) - mmlLoop) < 1e-6;
  const agrees = loop !== null && idx === loop;
  if (!(exact || agrees)) {
    warn(
      ctx,
      "/loop",
      `MML loop point L at pulse ${mmlLoop} is not on an order boundary and was rounded to order ${idx}`
    );
  } else if (!agrees && doc.loop !== undefined && doc.loop !== null) {
    warn(
      ctx,
      "/loop",
      `MML loop point L overrides loop ${show(doc.loop)}, the song loops to order ${idx}`
    );
  }
  return idx;
}

function readMaster(
  ctx: Ctx,
  doc: Rec,
  chip: ChipId,
  profile: ChipProfile
): SongMaster {
  const m = section(ctx, doc, "master", "");
  dropUnknown(ctx, m, "/master", ["volume", "echo", "reverb"]);
  const master: SongMaster = {
    volume: numField(ctx, m, "volume", "/master", { min: 0, max: 1, def: 0.8 }),
    echo: readEcho(ctx, m.echo),
    reverb: readReverb(ctx, m.reverb),
  };
  if (!profile.constraints.masterFx) {
    if (master.echo) {
      warn(
        ctx,
        "/master/echo",
        `chip "${chip}" has no master effects, the echo is ignored`
      );
    }
    if (master.reverb) {
      warn(
        ctx,
        "/master/reverb",
        `chip "${chip}" has no master effects, the reverb is ignored`
      );
    }
  }
  return master;
}

export function normalizeSong(
  input: unknown,
  instruments?: Record<string, Instrument>
): Normalized<Song> {
  const ctx = newCtx();
  if (!isRec(input)) {
    error(ctx, "", `must be an object (was ${show(input)})`);
    return finish(ctx, defaultSong());
  }
  const from = readVersion(ctx, input, FORMAT_VERSION);
  const doc = migrate(input, from);
  dropUnknown(ctx, doc, "", SONG_KEYS);
  const id = readId(ctx, doc);

  const chip = enumField(ctx, doc, "chip", "", CHIP_IDS, "nes");
  const profile = CHIPS[chip];
  const tempo0 = numField(ctx, doc, "tempo", "", {
    min: 20,
    max: 400,
    def: 120,
  });
  const rowsPerBeat = numField(ctx, doc, "rowsPerBeat", "", {
    min: 1,
    max: 16,
    int: true,
    def: 4,
  });
  const tickRate = enumField(ctx, doc, "tickRate", "", [50, 60] as const, 60);
  const refs: Refs = { used: new Map() };
  const rowPaths = new WeakMap<Row, string>();

  const { channels, infos } = readChannels(
    ctx,
    doc,
    chip,
    profile,
    instruments,
    refs
  );
  const patterns = readPatterns(ctx, doc, {
    chip,
    infos,
    instruments,
    refs,
    rowPaths,
  });
  const mml = summarizeMml(ctx, infos, chip, instruments, refs);
  const patternIds = Object.keys(patterns);
  // an MML-only song: no rows anywhere, so the MML decides the song's tempo, length and loop
  const synthInput =
    mml.any &&
    !hasAnyRows(patterns) &&
    (patternIds.length === 0 || patternIds.every((k) => SYNTH_ID_RE.test(k)));
  const { tempo: mmlTempo } = mml;
  let tempo = tempo0;
  if (mmlTempo !== null) {
    if (synthInput) {
      tempo = mmlTempo;
    } else if (Math.abs(mmlTempo - tempo0) > 1e-9) {
      warn(
        ctx,
        "/tempo",
        `MML sets tempo ${mmlTempo} but the song tempo is ${tempo0}, the song tempo is used`
      );
    }
  }

  // Structure: patterns and order. An MML-only song gets synthesized patterns (empty, structure only).
  const structure = synthInput
    ? { ...synthesizeStructure(mml.end, rowsPerBeat), synthesized: true }
    : { order: readOrder(ctx, doc, patterns), patterns, synthesized: false };
  if (structure.order.length === 0) {
    structure.order = fallbackOrder(ctx, doc, structure.patterns);
  }
  const { order, patterns: outPatterns } = structure;
  const loop = resolveLoop(ctx, doc, structure, PPQ / rowsPerBeat, mml.loop);

  // jump targets are checked once the order length is final
  checkJumps(ctx, outPatterns, order.length, rowPaths);
  const master = readMaster(ctx, doc, chip, profile);
  instrumentWarnings(ctx, chip, instruments, refs);

  const value: Song = {
    version: FORMAT_VERSION,
    name: strField(ctx, doc, "name", "", "Untitled"),
    chip,
    tempo,
    rowsPerBeat,
    tickRate,
    channels,
    patterns: outPatterns,
    order,
    loop,
    master,
  };
  if (id !== undefined) {
    (value as Song & { id?: string }).id = id;
  }
  return finish(ctx, value);
}

function readOrder(
  ctx: Ctx,
  doc: Rec,
  patterns: Record<string, Pattern>
): string[] {
  const raw = doc.order;
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    error(ctx, "/order", `must be an array of pattern ids (was ${show(raw)})`);
    return [];
  }
  let list: unknown[] = raw;
  if (list.length > 256) {
    warn(
      ctx,
      "/order",
      `must have at most 256 entries (had ${list.length}), extra entries were dropped`
    );
    list = list.slice(0, 256);
  }
  const out: string[] = [];
  for (const [i, v] of list.entries()) {
    const p = ptr("/order", i);
    if (typeof v !== "string") {
      error(ctx, p, `must be a pattern id (was ${show(v)})`);
    } else if (Object.hasOwn(patterns, v)) {
      out.push(v);
    } else {
      error(ctx, p, `pattern "${v}" does not exist`);
    }
  }
  return out;
}

function readLoop(ctx: Ctx, doc: Rec, orderLength: number): number | null {
  const v = doc.loop;
  if (v === undefined) {
    return 0;
  }
  if (v === null) {
    return null;
  }
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    error(ctx, "/loop", `must be an order index or null (was ${show(v)})`);
    return 0;
  }
  if (v >= orderLength) {
    error(
      ctx,
      "/loop",
      `must be an order index below ${orderLength} (was ${v})`
    );
    return 0;
  }
  return v;
}

/** Drop the jump effects of a row whose target is outside the order list. */
function dropBadJumps(
  ctx: Ctx,
  row: Row,
  path: string | undefined,
  orderLength: number
) {
  const kept: Effect[] = [];
  for (const [k, e] of row.fx.entries()) {
    if (e.type === "jump" && effectByte(e) >= orderLength) {
      error(
        ctx,
        path === undefined ? "/patterns" : ptr(ptr(path, "fx"), k),
        `jump target ${effectByte(e)} must be inside the order list (0 to ${orderLength - 1}), the effect was dropped`
      );
    } else {
      kept.push(e);
    }
  }
  row.fx = kept;
}

function checkJumps(
  ctx: Ctx,
  patterns: Record<string, Pattern>,
  orderLength: number,
  rowPaths: WeakMap<Row, string>
): void {
  for (const pat of Object.values(patterns)) {
    for (const rows of Object.values(pat.tracks)) {
      for (const row of rows) {
        dropBadJumps(ctx, row, rowPaths.get(row), orderLength);
      }
    }
  }
}

function instrumentWarnings(
  ctx: Ctx,
  chip: ChipId,
  instruments: Record<string, Instrument> | undefined,
  refs: Refs
): void {
  if (!instruments) {
    return;
  }
  const want = CHIPS[chip].channels.find((c) => c.kind === "fm")?.fmOps ?? null;
  for (const [id, path] of refs.used) {
    const inst = instruments[id];
    if (!inst) {
      continue;
    }
    if (chip !== "custom" && inst.chip !== null && inst.chip !== chip) {
      warn(
        ctx,
        path,
        `instrument "${id}" was designed for chip "${inst.chip}", this song uses "${chip}"`
      );
    }
    if (
      inst.kind === "fm" &&
      inst.fm &&
      want !== null &&
      inst.fm.ops.length !== want
    ) {
      warn(
        ctx,
        path,
        inst.fm.ops.length > want
          ? `instrument "${id}" has ${inst.fm.ops.length} operators, chip "${chip}" uses operators 0 and 1 with algorithm min(algorithm, 1)`
          : `instrument "${id}" has ${inst.fm.ops.length} operators, chip "${chip}" has ${want}, the missing operators stay silent`
      );
    }
  }
}
