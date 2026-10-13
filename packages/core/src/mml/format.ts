/* MML formatting: events back to text, and tracker rows back to text. */

import { effectByte, formatEffect } from "../normalize/effects.ts";
import type { Effect, MmlEvent, MmlOptions, Row } from "../types.ts";
import { PPQ } from "../types.ts";
import { type GridTiming, pulsesForTicks, tickPhase } from "./grid.ts";
import { dotFactor, VALID_LENGTHS } from "./parser.ts";

const WHOLE = 384;
const NAMES = [
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
] as const;
const EPS = 1e-6;

/** Every length token with its pulses (4 is 96, 8.. is 84): the pieces a duration is made of. */
const PIECES: readonly { token: string; value: number }[] =
  VALID_LENGTHS.flatMap((n) =>
    [0, 1, 2, 3].map((dots) => ({
      token: `${n}${".".repeat(dots)}`,
      value: (WHOLE / n) * dotFactor(dots),
    }))
  ).sort((a, b) => b.value - a.value);

/** The largest piece that fits in `left` pulses, or null when `left` is shorter than the shortest. */
function largestPiece(left: number): { token: string; value: number } | null {
  return PIECES.find((p) => p.value <= left + EPS) ?? null;
}

/**
 * A whole number of pulses as the fewest pieces, for the durations the largest-first choice misses (22 = 12 + 6 + 4,
 * where largest first leaves 1, which no piece can say). The pieces are whole pulses from 2 up.
 */
function exactTokens(pulses: number): string[] {
  const best: number[] = [0];
  const via: number[] = [];
  for (let n = 1; n <= pulses; n += 1) {
    best[n] = Number.POSITIVE_INFINITY;
    for (const [i, p] of PIECES.entries()) {
      const rest = best[n - p.value];
      if (
        Number.isInteger(p.value) &&
        rest !== undefined &&
        rest + 1 < (best[n] ?? 0)
      ) {
        best[n] = rest + 1;
        via[n] = i;
      }
    }
  }
  const out: string[] = [];
  for (let n = pulses; n > 0 && via[n] !== undefined; ) {
    const p = PIECES[via[n] ?? 0];
    out.push(p?.token ?? "4");
    n -= p?.value ?? n;
  }
  return out;
}

/** Length tokens ("4", "8..") for a duration in pulses, as one entry or several that tie or follow each other. */
function lengthTokens(pulses: number): string[] {
  const out: string[] = [];
  let left = pulses;
  let guard = 0;
  while (left > EPS && guard < 64) {
    guard += 1;
    const best = largestPiece(left);
    if (best === null) {
      // shorter than the shortest length
      const whole = Math.abs(pulses - Math.round(pulses)) < EPS;
      if (whole && pulses >= 2) {
        return exactTokens(Math.round(pulses));
      }
      // a fraction of a pulse, or a single one: use the shortest so the text still parses
      out.push(`${VALID_LENGTHS.at(-1) ?? 192}`);
      break;
    }
    out.push(best.token);
    left -= best.value;
  }
  return out.length > 0 ? out : ["4"];
}

function noteText(
  note: number,
  octave: number
): { text: string; octave: number } {
  const oct = Math.floor(note / 12) - 1;
  if (oct < 0 || oct > 8) {
    return { octave, text: `n${note}` };
  }
  const prefix = oct === octave ? "" : `o${oct} `;
  return { octave: oct, text: `${prefix}${NAMES[note % 12] ?? "c"}` };
}

function joinNotes(
  head: string,
  lengths: string[],
  isNumeric: boolean
): string {
  const parts = lengths.map((l) =>
    isNumeric ? `${head} ${l}` : `${head}${l}`
  );
  return parts.join("&");
}

type NoteEvent = Extract<MmlEvent, { type: "note" }>;

/** What the text has set so far: formatting only repeats a command when a note needs a different value. */
interface FormatState {
  gate: number;
  inst: string | null;
  octave: number;
  volume: number;
}

/** The v, @ and q commands a note needs because its settings differ from the running ones. */
function writeNoteSettings(e: NoteEvent, st: FormatState, out: string[]) {
  if (e.volume !== st.volume) {
    st.volume = e.volume;
    out.push(`v${e.volume}`);
  }
  if (e.inst !== null && e.inst !== st.inst) {
    st.inst = e.inst;
    out.push(`@${e.inst}`);
  }
  const q = Math.min(8, Math.max(1, Math.round((8 * e.gate) / e.duration)));
  if (q !== st.gate) {
    st.gate = q;
    out.push(`q${q}`);
  }
}

function writeNote(e: NoteEvent, st: FormatState, out: string[]) {
  writeNoteSettings(e, st, out);
  for (const fx of e.fx) {
    out.push(`{${formatEffect(fx)}}`);
  }
  const nt = noteText(e.note, st.octave);
  st.octave = nt.octave;
  const lengths = lengthTokens(e.duration);
  if (nt.text.includes(" ")) {
    // "o5 c": the octave command stays in front, ties repeat only the letter
    const [oct, letter] = nt.text.split(" ") as [string, string];
    out.push(`${oct} ${joinNotes(letter, lengths, false)}`);
  } else {
    out.push(joinNotes(nt.text, lengths, nt.text.startsWith("n")));
  }
}

function writeEvent(e: MmlEvent, st: FormatState, out: string[]) {
  switch (e.type) {
    case "volume":
      st.volume = e.value;
      out.push(`v${e.value}`);
      break;
    case "inst":
      st.inst = e.id;
      out.push(`@${e.id}`);
      break;
    case "pan":
      out.push(`p${e.value}`);
      break;
    case "loop":
      out.push("L");
      break;
    case "rest":
      out.push(
        lengthTokens(e.duration)
          .map((l) => `r${l}`)
          .join(" ")
      );
      break;
    case "note":
      writeNote(e, st, out);
      break;
    default:
      break;
  }
}

/** Events to MML text. Reparsing the text yields the same events (for events that came from parseMml). */
export function formatMml(
  events: readonly MmlEvent[],
  opts: MmlOptions = {}
): string {
  const out: string[] = [];
  const st: FormatState = {
    gate: 8,
    inst: null,
    octave: opts.octave ?? 4,
    volume: opts.volume ?? 15,
  };
  for (const e of events) {
    writeEvent(e, st, out);
  }
  return out.join(" ");
}

/**
 * What turns delays and cuts into pulses: the song's tempo and tick rate (ticks per second), the tempo changes in the
 * song (`changes`, [pulse, BPM]), the loop start the engine anchors its ticks at again, and the song row the pattern
 * starts at. Without the last three the song is taken to hold one tempo and the pattern to start the song.
 */
type TextTiming = Omit<GridTiming, "rowsPerBeat"> & { startRow?: number };

const isTimed = (e: Effect): boolean => e.type === "delay" || e.type === "cut";

/** The ticks of a row's delay or cut effect, 0 when it has none. A cut of 0 still cuts on the first tick. */
function ticksOf(r: Row, type: "cut" | "delay"): number {
  const e = r.fx.find((x) => x.type === type);
  if (!e) {
    return 0;
  }
  const xx = effectByte(e);
  return type === "cut" ? Math.max(1, xx) : xx;
}

/** Everything `patternToMml` needs to turn rows into pulses. */
interface Layout {
  grid: GridTiming | null;
  length: number | undefined;
  pulsesPerRow: number;
  sorted: readonly Row[];
  startPulse: number;
}

/**
 * The pulse a row's delay or cut falls on, in whole pulses (the finest an MML length can say). The xx-th tick after a
 * row is xx ticks after the tick before the row, which is a fraction of a tick before the row starts.
 */
function pulseOf(l: Layout, r: Row, type: "cut" | "delay"): number {
  const start = r.row * l.pulsesPerRow;
  const ticks = l.grid ? ticksOf(r, type) : 0;
  if (!l.grid || ticks <= 0) {
    return start;
  }
  const at = l.startPulse + start;
  const into = ticks - tickPhase(l.grid, at);
  return Math.round(start + pulsesForTicks(l.grid, at, into));
}

const isNoteStop = (r: Row): boolean =>
  typeof r.note === "number" || r.note === "off" || r.note === "release";

/** The pulse of the next row that has a note, an off or a release, and the row's index; infinity when there is none. */
function nextStop(l: Layout, index: number): { at: number; index: number } {
  for (let k = index + 1; k < l.sorted.length; k += 1) {
    const r = l.sorted[k];
    if (r && isNoteStop(r)) {
      const at =
        typeof r.note === "number"
          ? pulseOf(l, r, "delay")
          : r.row * l.pulsesPerRow;
      return { at, index: k };
    }
  }
  return { at: Number.POSITIVE_INFINITY, index: l.sorted.length };
}

/**
 * The pulse a note ends at: where the next note, off or release starts, or earlier where a cut on its row or on a
 * row without a note in between falls; else the end of the pattern (when `length` is given) or one row.
 */
function noteEnd(l: Layout, index: number, start: number): number {
  const next = nextStop(l, index);
  let stop = next.at;
  if (l.grid) {
    for (let j = index; j < next.index; j += 1) {
      const r = l.sorted[j];
      const cut = r && ticksOf(r, "cut") > 0 ? pulseOf(l, r, "cut") : stop;
      if (cut > start && cut < stop) {
        stop = cut;
      }
    }
  }
  const at = l.sorted[index]?.row ?? 0;
  return Number.isFinite(stop)
    ? stop
    : Math.max(at + 1, l.length ?? 0) * l.pulsesPerRow;
}

/**
 * One pattern track (sparse rows) to MML. A note lasts until the next row that has a note or an off; the last note
 * lasts to the end of the pattern when its `length` is given (as a note with no off does in the engine), else one row.
 * With the song's `timing`, a delay (Gxx) is a rest before the note and a cut (Sxx) ends the note early, in whole
 * pulses, so that `mmlToRows` with the same timing gives the rows back; without it, delays and cuts are left as
 * effects in braces.
 */
export function patternToMml(
  rows: readonly Row[],
  rowsPerBeat: number,
  length?: number,
  timing?: TextTiming
): string {
  const pulsesPerRow = PPQ / rowsPerBeat;
  const l: Layout = {
    grid: timing ? { ...timing, rowsPerBeat } : null,
    length,
    pulsesPerRow,
    sorted: [...rows].sort((a, b) => a.row - b.row),
    startPulse: (timing?.startRow ?? 0) * pulsesPerRow,
  };
  const events: MmlEvent[] = [];
  let cursor = 0;
  let volume = 15;
  let inst: string | null = null;
  for (const [idx, r] of l.sorted.entries()) {
    const rowPulse = r.row * l.pulsesPerRow;
    if (r.inst !== null && r.inst !== inst) {
      ({ inst } = r);
      events.push({ id: r.inst, pulse: rowPulse, type: "inst" });
    }
    if (r.vol !== null && r.vol !== volume) {
      volume = r.vol;
      events.push({ pulse: rowPulse, type: "volume", value: r.vol });
    }
    if (typeof r.note === "number") {
      const start = pulseOf(l, r, "delay");
      if (start > cursor + EPS) {
        events.push({ duration: start - cursor, pulse: cursor, type: "rest" });
      }
      const duration = noteEnd(l, idx, start) - start;
      events.push({
        duration,
        fx: l.grid ? r.fx.filter((e) => !isTimed(e)) : r.fx,
        gate: duration,
        inst,
        note: r.note,
        pulse: start,
        type: "note",
        volume,
      });
      cursor = start + duration;
    }
  }
  return formatMml(events);
}
