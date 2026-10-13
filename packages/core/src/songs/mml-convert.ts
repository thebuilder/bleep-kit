/* mmlToPatterns: the song with its MML channels turned into tracker patterns, so the grid is the one real editor
   (architecture.md section 2.7). MML stays a text input: this is where it becomes rows. Pure and deterministic.
   Timing between rows is kept the tracker way (`mmlToRows`): a delay Gxx on the row before a note, a cut Sxx on the
   row where a note ends. The song's rows per beat never change and every channel converts. */

import { type GridTiming, mmlToRows } from "../mml/grid.ts";
import { parseMml } from "../mml/parser.ts";
import {
  type MmlSource,
  SYNTH_PATTERN_BEATS,
  synthesizeStructure,
} from "../normalize/mml-structure.ts";
import { isMmlOnly } from "../normalize/song.ts";
import type { Issue, Pattern, Row, Song, SongChannel } from "../types.ts";
import { PPQ } from "../types.ts";
import { songTiming } from "./timing.ts";

const MAX_ORDER = 256;
const EPS = 1e-6;
const FLOW_EFFECTS = new Set(["jump", "skip", "halt"]);

/** One MML channel turned into rows. */
interface Converted {
  channel: SongChannel;
  index: number;
  loopRow: number | null;
  rows: Row[];
}

/**
 * A looping MML song starts every pass with the volume and instrument of the first note after the loop point. Rows
 * only change them when asked, so that note says them out loud when the end of the song left something else behind.
 */
function pinLoopState(rows: Row[], loopRow: number): void {
  let vol = 15;
  let inst: string | null = null;
  let atLoop: Row | null = null;
  let volAtLoop = vol;
  let instAtLoop: string | null = null;
  for (const r of rows) {
    vol = r.vol ?? vol;
    inst = r.inst ?? inst;
    if (atLoop === null && r.row >= loopRow && typeof r.note === "number") {
      atLoop = r;
      volAtLoop = vol;
      instAtLoop = inst;
    }
  }
  if (atLoop === null) {
    return;
  }
  if (vol !== volAtLoop) {
    atLoop.vol = volAtLoop;
  }
  if (instAtLoop !== null && inst !== instAtLoop) {
    atLoop.inst = instAtLoop;
  }
}

/** The rows from `start` for `length` rows, moved to start at 0. */
function sliceRows(rows: readonly Row[], start: number, length: number): Row[] {
  const out: Row[] = [];
  for (const r of rows) {
    if (r.row >= start && r.row < start + length) {
      out.push({ ...r, fx: r.fx.map((e) => ({ ...e })), row: r.row - start });
    }
  }
  return out;
}

/** A pattern id that no pattern uses yet: `base`, else `base 2`, `base 3`... */
function freeId(patterns: Record<string, Pattern>, base: string): string {
  let id = base;
  for (let n = 2; id in patterns; n += 1) {
    id = `${base} ${n}`;
  }
  return id;
}

/** One place in the order list while it is being filled: the pattern it came from and the rows it covers. */
interface Slot {
  base: string;
  length: number;
  start: number;
  tracks: Record<string, Row[]>;
}

/** Slots become patterns: slots of one base with the same content share a pattern, the rest get their own. */
function placeSlots(
  slots: readonly Slot[],
  patterns: Record<string, Pattern>
): string[] {
  const bySignature = new Map<string, string>();
  const order: string[] = [];
  for (const s of slots) {
    const key = `${s.base}\u0000${s.length}\u0000${JSON.stringify(s.tracks)}`;
    let id = bySignature.get(key);
    if (id === undefined) {
      id = freeId(patterns, s.base);
      bySignature.set(key, id);
      patterns[id] = { length: s.length, tracks: s.tracks };
    }
    order.push(id);
  }
  return order;
}

/** Cut the slot that holds `loopRow` in two so the loop starts on an order boundary; returns the loop's order index. */
function splitAtLoop(slots: Slot[], loopRow: number): number {
  const k = slots.findIndex(
    (s) => loopRow >= s.start && loopRow < s.start + s.length
  );
  const slot = slots[k];
  if (slot === undefined) {
    return 0;
  }
  if (loopRow === slot.start) {
    return k;
  }
  const head = loopRow - slot.start;
  const first: Slot = {
    base: `${slot.base} pre`,
    length: head,
    start: slot.start,
    tracks: {},
  };
  const second: Slot = {
    base: `${slot.base} loop`,
    length: slot.length - head,
    start: loopRow,
    tracks: {},
  };
  slots.splice(k, 1, first, second);
  return k + 1;
}

export interface MmlConversion {
  issues: Issue[];
  song: Song;
}

interface MmlChannel {
  channel: SongChannel;
  index: number;
}

function mmlChannelList(song: Song): MmlChannel[] {
  const out: MmlChannel[] = [];
  for (const [index, channel] of song.channels.entries()) {
    if (channel.mml !== null) {
      out.push({ channel, index });
    }
  }
  return out;
}

/** The result for a song nothing could be converted in: the same song and a warning per channel. */
function keepAll(
  song: Song,
  channels: readonly MmlChannel[],
  why: string
): MmlConversion {
  return {
    issues: channels.map((c) => ({
      message: `channel "${c.channel.id}" stays as MML text: ${why}`,
      path: `/channels/${c.index}/mml`,
      severity: "warning",
    })),
    song,
  };
}

/** The channels as rows at the song's rows per beat; what the conversion had to say about them becomes issues. */
function convertChannels(
  channels: readonly MmlChannel[],
  timing: GridTiming,
  endRow: number | null
): { converted: Converted[]; issues: Issue[] } {
  const converted: Converted[] = [];
  const issues: Issue[] = [];
  for (const c of channels) {
    const src = c.channel.mml ?? "";
    const own = parseMml(src).issues.length;
    const r = mmlToRows(src, timing, endRow === null ? {} : { endRow });
    for (const i of r.issues.slice(own)) {
      issues.push({
        message: `channel "${c.channel.id}": ${i.message}`,
        path: `/channels/${c.index}/mml`,
        severity: i.severity,
      });
    }
    converted.push({ ...c, loopRow: r.loopRow, rows: r.rows });
  }
  return { converted, issues };
}

function withConverted(
  song: Song,
  converted: readonly Converted[],
  extra: Partial<Song>
): Song {
  const done = new Set(converted.map((f) => f.index));
  return {
    ...song,
    ...extra,
    channels: song.channels.map((c, i) =>
      done.has(i) ? { ...c, mml: null } : c
    ),
  };
}

/** The slots of an MML-only song: one per four beats, the last one cut to the end of the music. */
function barSlots(
  sources: readonly MmlSource[],
  endPulse: number,
  timing: GridTiming
): Slot[] {
  const { rowsPerBeat } = timing;
  const perBar = SYNTH_PATTERN_BEATS * rowsPerBeat;
  const structure = synthesizeStructure(sources, endPulse, timing);
  const totalRows =
    endPulse > 0
      ? Math.ceil(endPulse / (PPQ / rowsPerBeat) - EPS)
      : structure.order.length * perBar;
  return structure.order.map((base, k) => ({
    base,
    length: Math.max(1, Math.min(perBar, totalRows - k * perBar)),
    start: k * perBar,
    tracks: {},
  }));
}

/** Put each converted channel's rows into the slots that cover them. */
function fillSlots(slots: Slot[], converted: readonly Converted[]): void {
  for (const f of converted) {
    for (const s of slots) {
      const rows = sliceRows(f.rows, s.start, s.length);
      if (rows.length > 0) {
        s.tracks[f.channel.id] = rows;
      }
    }
  }
}

function convertMmlOnly(song: Song): MmlConversion {
  const channels = mmlChannelList(song);
  const parsed = channels.map((c) => parseMml(c.channel.mml ?? ""));
  const sources: MmlSource[] = channels.map((c, i) => ({
    mml: c.channel.mml ?? "",
    sections: parsed[i]?.sections ?? [],
  }));
  const end = Math.max(0, ...parsed.map((p) => p.endPulse));
  if (Math.ceil(end / (SYNTH_PATTERN_BEATS * PPQ) - EPS) > MAX_ORDER) {
    return keepAll(song, channels, `it is longer than ${MAX_ORDER} bars`);
  }
  const ppr = PPQ / song.rowsPerBeat;
  const totalRows = Math.max(1, Math.ceil(end / ppr - EPS));
  const firstL = parsed.find((p) => p.loopPulse !== null)?.loopPulse ?? null;
  const loops = song.loop !== null || firstL !== null;
  // the tick grid is anchored again at the loop point: a pulse that is not on a row starts on the row before it
  const timing = songTiming(
    song,
    loops ? Math.floor((firstL ?? 0) / ppr + EPS) * ppr : null
  );
  const { converted, issues } = convertChannels(
    channels,
    timing,
    loops ? totalRows : null
  );
  const firstLoop = converted.find((f) => f.loopRow !== null)?.loopRow ?? null;
  const loopRow =
    song.loop === null && firstLoop === null ? null : (firstLoop ?? 0);
  if (loopRow !== null) {
    for (const f of converted) {
      pinLoopState(f.rows, loopRow);
    }
  }
  const slots = barSlots(sources, end, timing);
  const loop = loopRow === null ? null : splitAtLoop(slots, loopRow);
  if (slots.length > MAX_ORDER) {
    return keepAll(
      song,
      channels,
      `splitting at the loop point makes more than ${MAX_ORDER} order entries`
    );
  }
  fillSlots(slots, converted);
  const patterns: Record<string, Pattern> = {};
  const order = placeSlots(slots, patterns);
  return {
    issues,
    song: withConverted(song, converted, { loop, order, patterns }),
  };
}

/** True when a pattern the order plays changes the flow (jump, skip, halt): the rows then do not play in time order. */
function hasFlowEffects(song: Song): boolean {
  return song.order.some((id) =>
    Object.values(song.patterns[id]?.tracks ?? {}).some((rows) =>
      rows.some((r) => r.fx.some((e) => FLOW_EFFECTS.has(e.type)))
    )
  );
}

/** The order list as slots that carry the pattern's other channels; the converted channels' rows are added after. */
function orderSlots(song: Song, converted: ReadonlySet<string>): Slot[] {
  const slots: Slot[] = [];
  let start = 0;
  for (const id of song.order) {
    const pat = song.patterns[id];
    const length = pat?.length ?? 0;
    const tracks: Record<string, Row[]> = {};
    for (const [ch, rows] of Object.entries(pat?.tracks ?? {})) {
      if (!converted.has(ch)) {
        tracks[ch] = rows;
      }
    }
    slots.push({ base: id, length, start, tracks });
    start += length;
  }
  return slots;
}

/** Patterns that came out of the conversion the same are one pattern again (the first in the order list stays). */
function mergeIdentical(
  patterns: Record<string, Pattern>,
  order: string[],
  touched: ReadonlySet<string>
): string[] {
  const seen = new Map<string, string>();
  const remap = new Map<string, string>();
  for (const id of order) {
    const pat = patterns[id];
    if (pat === undefined || !touched.has(id) || remap.has(id)) {
      continue;
    }
    const key = JSON.stringify([pat.length, pat.tracks]);
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, id);
    } else if (first !== id) {
      remap.set(id, first);
    }
  }
  for (const id of remap.keys()) {
    delete patterns[id];
  }
  return order.map((id) => remap.get(id) ?? id);
}

function convertMixed(song: Song): MmlConversion {
  const channels = mmlChannelList(song);
  if (hasFlowEffects(song)) {
    return keepAll(
      song,
      channels,
      "the patterns jump, skip or halt, so the rows do not play in time order"
    );
  }
  const timing = songTiming(song);
  const totalRows = song.order.reduce(
    (sum, id) => sum + (song.patterns[id]?.length ?? 0),
    0
  );
  const { converted, issues } = convertChannels(
    channels,
    timing,
    song.loop === null ? null : totalRows
  );
  const slots = orderSlots(song, new Set(converted.map((f) => f.channel.id)));
  fillSlots(slots, converted);
  for (const f of converted) {
    const lost = f.rows.filter(
      (r) => r.row >= totalRows && typeof r.note === "number"
    );
    if (lost.length > 0) {
      issues.push({
        message: `channel "${f.channel.id}": ${lost.length} MML notes past the end of the song were left out`,
        path: `/channels/${f.index}/mml`,
        severity: "info",
      });
    }
  }
  const patterns: Record<string, Pattern> = {};
  for (const [id, pat] of Object.entries(song.patterns)) {
    if (!song.order.includes(id)) {
      patterns[id] = pat;
    }
  }
  const order = placeSlots(slots, patterns);
  const names = converted.map((f) => f.channel.id);
  const touched = new Set(
    order.filter((id) => names.some((ch) => ch in (patterns[id]?.tracks ?? {})))
  );
  return {
    issues,
    song: withConverted(song, converted, {
      order: mergeIdentical(patterns, order, touched),
      patterns,
    }),
  };
}

/**
 * The song with its MML channels turned into tracker patterns, and what it could not turn (a warning per channel
 * that stays MML). Takes a normalized song; returns the song itself when there is nothing to convert.
 *
 * An MML-only song gets the structure normalize gives it (patterns of four beats named for the sections, shared
 * between bars that hold the same music), filled with the channels' rows, `generated` dropped, the loop set to the
 * order index of the MML loop point (a pattern is cut in two there when needed) and the last pattern cut to the end
 * of the music. A mixed song has each channel's rows cut into the order slots, a pattern that several slots play is
 * cloned where the slices differ, and patterns that end up the same are merged.
 *
 * Timing between rows (triplets, `q` gates, odd lengths) is kept with a delay `Gxx` on the row before a note and a
 * cut `Sxx` on the row where a note ends (xx in engine ticks, so a tick of rounding at most). The rows per beat stay
 * the song's own and every channel converts, except when the patterns jump, skip or halt (the rows then do not play
 * in time order) or the song is longer than 256 bars: those stay MML and are reported.
 */
export function mmlToPatterns(song: Song): MmlConversion {
  if (mmlChannelList(song).length === 0) {
    return { issues: [], song };
  }
  return isMmlOnly(song) ? convertMmlOnly(song) : convertMixed(song);
}
