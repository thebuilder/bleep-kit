/* mmlToPatterns: the song with its MML channels turned into tracker patterns, so the grid is the one real editor
   (architecture.md section 2.7). MML stays a text input: this is where it becomes rows. Pure and deterministic. */

import { mmlToTrack } from "../mml/index.ts";
import { parseMml } from "../mml/parser.ts";
import {
  type MmlSource,
  SYNTH_PATTERN_BEATS,
  synthesizeStructure,
} from "../normalize/mml-structure.ts";
import { isMmlOnly } from "../normalize/song.ts";
import type { Issue, Pattern, Row, Song, SongChannel } from "../types.ts";
import { PPQ } from "../types.ts";

const MAX_RPB = 16;
const MAX_ORDER = 256;
const EPS = 1e-6;
const ROUNDED_TAIL_RE = / and was rounded to row \d+$/;
const FLOW_EFFECTS = new Set(["jump", "skip", "halt"]);

/** What converting one MML channel at one rows-per-beat gives. */
interface Fit {
  channel: SongChannel;
  index: number;
  loopPulse: number | null;
  /** Why the channel does not fit the grid, or null when it does. */
  problem: string | null;
  rows: Row[];
}

/** The song's own rows per beat and its multiples up to the largest the format allows. */
function candidates(rowsPerBeat: number): number[] {
  const out: number[] = [];
  for (let n = rowsPerBeat; n <= MAX_RPB; n += rowsPerBeat) {
    out.push(n);
  }
  return out;
}

const onGrid = (pulse: number, pulsesPerRow: number): boolean => {
  const r = pulse / pulsesPerRow;
  return Math.abs(r - Math.round(r)) <= EPS;
};

/** The MML of a channel as rows at `rowsPerBeat`, and what stops them from being exact. */
function fitChannel(
  channel: SongChannel,
  index: number,
  rowsPerBeat: number
): Fit {
  const src = channel.mml ?? "";
  const parsed = parseMml(src);
  const track = mmlToTrack(src, rowsPerBeat);
  const pulsesPerRow = PPQ / rowsPerBeat;
  const off = track.issues.slice(parsed.issues.length);
  let problem: string | null = null;
  if (off.length > 0) {
    const first = (off[0]?.message ?? "").replace(ROUNDED_TAIL_RE, "");
    const more = off.length > 1 ? `, and ${off.length - 1} more` : "";
    problem = `its timing does not fit the grid (${first}${more})`;
  } else if (!onGrid(parsed.endPulse, pulsesPerRow)) {
    problem = `its timing does not fit the grid (it ends at pulse ${parsed.endPulse}, between rows)`;
  } else if (
    parsed.loopPulse !== null &&
    !onGrid(parsed.loopPulse, pulsesPerRow)
  ) {
    problem = `its timing does not fit the grid (the loop point L is at pulse ${parsed.loopPulse}, between rows)`;
  }
  return {
    channel,
    index,
    loopPulse: parsed.loopPulse,
    problem,
    rows: track.rows,
  };
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

function pulsesToRow(pulse: number, pulsesPerRow: number): number {
  return Math.round(pulse / pulsesPerRow);
}

/** The loop point the MML playback uses: the first channel's L, else the start; none when the song plays once. */
function mmlLoopPulse(song: Song, fits: readonly Fit[]): number | null {
  const first = fits.find((f) => f.loopPulse !== null)?.loopPulse ?? null;
  if (song.loop === null && first === null) {
    return null;
  }
  return first ?? 0;
}

function keptIssue(f: Fit, why: string): Issue {
  return {
    message: `channel "${f.channel.id}" stays as MML text: ${why}`,
    path: `/channels/${f.index}/mml`,
    severity: "warning",
  };
}

function withConverted(
  song: Song,
  fits: readonly Fit[],
  extra: Partial<Song>
): Song {
  const done = new Set(
    fits.filter((f) => f.problem === null).map((f) => f.index)
  );
  return {
    ...song,
    ...extra,
    channels: song.channels.map((c, i) =>
      done.has(i) ? { ...c, mml: null } : c
    ),
  };
}

export interface MmlConversion {
  issues: Issue[];
  song: Song;
}

interface Pick {
  fits: Fit[];
  rowsPerBeat: number;
}

/** The rows per beat (the song's own, else a multiple) where the most channels fit; the smallest wins a tie. */
function pickRowsPerBeat(
  channels: readonly MmlChannel[],
  rowsPerBeat: number
): Pick | null {
  let best: (Pick & { ok: number }) | null = null;
  for (const rpb of candidates(rowsPerBeat)) {
    const fits = channels.map((c) => fitChannel(c.channel, c.index, rpb));
    const ok = fits.filter((f) => f.problem === null).length;
    if (ok > (best?.ok ?? 0)) {
      best = { fits, ok, rowsPerBeat: rpb };
    }
    if (ok === fits.length) {
      break;
    }
  }
  return best;
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
  const fits = channels.map((c) =>
    fitChannel(c.channel, c.index, song.rowsPerBeat)
  );
  return {
    issues: fits.map((f) => keptIssue(f, f.problem ?? why)),
    song,
  };
}

function keptIssues(fits: readonly Fit[]): Issue[] {
  return fits
    .filter((f) => f.problem !== null)
    .map((f) => keptIssue(f, f.problem ?? ""));
}

/** The slots of an MML-only song: one per four beats, the last one cut to the end of the music. */
function barSlots(
  sources: readonly MmlSource[],
  endPulse: number,
  rowsPerBeat: number
): Slot[] {
  const perBar = SYNTH_PATTERN_BEATS * rowsPerBeat;
  const structure = synthesizeStructure(sources, endPulse, rowsPerBeat);
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
function fillSlots(slots: Slot[], fits: readonly Fit[]): void {
  for (const f of fits) {
    if (f.problem !== null) {
      continue;
    }
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
  const pick = pickRowsPerBeat(channels, song.rowsPerBeat);
  if (pick === null) {
    return keepAll(song, channels, "its timing does not fit the grid");
  }
  const { fits, rowsPerBeat } = pick;
  const ppr = PPQ / rowsPerBeat;
  const sources: MmlSource[] = channels.map((c) => ({
    mml: c.channel.mml ?? "",
    sections: parseMml(c.channel.mml ?? "").sections,
  }));
  const end = Math.max(
    0,
    ...channels.map((c) => parseMml(c.channel.mml ?? "").endPulse)
  );
  if (Math.ceil(end / (SYNTH_PATTERN_BEATS * PPQ) - EPS) > MAX_ORDER) {
    return keepAll(song, channels, `it is longer than ${MAX_ORDER} bars`);
  }
  const loopPulse = mmlLoopPulse(song, fits);
  const loopRow = loopPulse === null ? null : pulsesToRow(loopPulse, ppr);
  if (loopRow !== null) {
    for (const f of fits) {
      pinLoopState(f.rows, loopRow);
    }
  }
  const slots = barSlots(sources, end, rowsPerBeat);
  const loop = loopRow === null ? null : splitAtLoop(slots, loopRow);
  if (slots.length > MAX_ORDER) {
    return keepAll(
      song,
      channels,
      `splitting at the loop point makes more than ${MAX_ORDER} order entries`
    );
  }
  fillSlots(slots, fits);
  const patterns: Record<string, Pattern> = {};
  const order = placeSlots(slots, patterns);
  return {
    issues: keptIssues(fits),
    song: withConverted(song, fits, { loop, order, patterns, rowsPerBeat }),
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
  const fits = channels.map((c) =>
    fitChannel(c.channel, c.index, song.rowsPerBeat)
  );
  const ok = fits.filter((f) => f.problem === null);
  if (ok.length === 0) {
    return { issues: keptIssues(fits), song };
  }
  const slots = orderSlots(song, new Set(ok.map((f) => f.channel.id)));
  fillSlots(slots, fits);
  const issues = keptIssues(fits);
  const totalRows = slots.reduce((sum, s) => sum + s.length, 0);
  for (const f of ok) {
    const lost = f.rows.filter((r) => r.row >= totalRows && r.note !== "off");
    if (lost.length > 0) {
      issues.push({
        message: `channel "${f.channel.id}": ${lost.length} MML rows past the end of the song were left out`,
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
  const converted = ok.map((f) => f.channel.id);
  const touched = new Set(
    order.filter((id) =>
      converted.some((ch) => ch in (patterns[id]?.tracks ?? {}))
    )
  );
  return {
    issues,
    song: withConverted(song, fits, {
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
 * Timing between rows (triplets, odd lengths) is never snapped: an MML-only song tries multiples of its rows per
 * beat up to 16 and uses the smallest that fits the most channels; what still does not fit stays MML.
 */
export function mmlToPatterns(song: Song): MmlConversion {
  if (mmlChannelList(song).length === 0) {
    return { issues: [], song };
  }
  return isMmlOnly(song) ? convertMmlOnly(song) : convertMixed(song);
}
