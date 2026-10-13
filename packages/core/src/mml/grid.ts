/* MML to tracker rows, the tracker way (architecture.md section 2.7). The grid has no room between rows, so a note
   that starts between two rows goes on the row at or before it with a delay `Gxx` (xx engine ticks), and a note that
   ends between rows gets a cut `Sxx` (xx ticks after the row) on the row where it ends. Nothing is snapped and the
   rows per beat never change. A tick is 1 / tickRate seconds whatever the tempo, so the tempo in force at a row
   turns pulses into ticks. The engine counts ticks from the start of the song (and again from the start of the loop
   section), a row usually starts between two ticks, and `Gxx` or `Sxx` fires on the xx-th tick after the row: the
   rounding below puts that tick as near the MML's own time as the tick grid allows. */

import { effectFromByte } from "../normalize/effects.ts";
import type { Effect, Issue, MmlEvent, MmlOptions, Row } from "../types.ts";
import { PPQ } from "../types.ts";
import { MML_PATH, parseMml } from "./parser.ts";

const EPS = 1e-6;
const MAX_FX = 4;
/** The largest xx of a cut: a byte. */
const MAX_TICKS = 255;

/** MML pan p0..p15 (8 = center) to the X effect byte: 0x00 left, 0x80 center, 0xFF right. */
export function mmlPanToByte(p: number): number {
  return p <= 8
    ? Math.round((p / 8) * 128)
    : 128 + Math.round(((p - 8) / 7) * 127);
}

/** What turns pulses into rows and ticks. */
export interface GridTiming {
  /** Tempo changes as [pulse, BPM], ascending; `tempo` holds before the first. */
  changes?: readonly (readonly [number, number])[];
  /** The pulse the tick grid is anchored at again (the start of the loop section); ticks count from 0 before it. */
  loopStart?: number;
  rowsPerBeat: number;
  /** Beats per minute at the start. */
  tempo: number;
  /** Engine ticks per second (60 or 50). */
  tickRate: number;
}

export interface GridOptions extends MmlOptions {
  /**
   * The song ends after this many rows: a note that lasts exactly to the end is cut at the end of the last row, as
   * the note off at the end of the music does. Leave it out for the text of one pattern.
   */
  endRow?: number;
  /** The song row the text starts at (the text of one pattern), so tempo and tick positions are the song's. */
  startRow?: number;
}

/** Where a pulse lands: a row, and how many ticks after the row it starts (0 = on the row). */
interface Spot {
  delay: number;
  row: number;
}

type NoteEvent = Extract<MmlEvent, { type: "note" }>;

interface Ctx {
  /** Pulses from the song start to the start of the text. */
  base: number;
  byRow: Map<number, Row>;
  endRow: number | null;
  issues: Issue[];
  ppr: number;
  timing: GridTiming;
}

function warn(ctx: Ctx, message: string) {
  ctx.issues.push({ message, path: MML_PATH, severity: "warning" });
}

function bpmAt(timing: GridTiming, pulse: number): number {
  let bpm = timing.tempo;
  for (const [p, b] of timing.changes ?? []) {
    if (p > pulse + EPS) {
      break;
    }
    bpm = b;
  }
  return bpm;
}

/** Ticks in one pulse at a tempo: a quarter note (96 pulses) lasts 60 / bpm seconds. */
function ticksPerPulse(timing: GridTiming, bpm: number): number {
  return (60 * timing.tickRate) / (PPQ * bpm);
}

/** The ticks from song pulse `from` to song pulse `to`, following the tempo changes in between. */
function ticksBetween(timing: GridTiming, from: number, to: number): number {
  let ticks = 0;
  let at = from;
  for (const [p] of timing.changes ?? []) {
    if (p > at + EPS && p < to - EPS) {
      ticks += (p - at) * ticksPerPulse(timing, bpmAt(timing, at));
      at = p;
    }
  }
  return ticks + (to - at) * ticksPerPulse(timing, bpmAt(timing, at));
}

/** Where the engine's tick grid is anchored for a song pulse: the start of the loop section, or the song start. */
function anchorOf(timing: GridTiming, pulse: number): number {
  const start = timing.loopStart ?? 0;
  return pulse >= start - EPS ? start : 0;
}

/** The ticks from the anchor to a song pulse. */
function tickPos(timing: GridTiming, pulse: number): number {
  return ticksBetween(timing, anchorOf(timing, pulse), pulse);
}

/**
 * Where a row that starts at song pulse `rowPulse` falls between two ticks, 0 to 1 (0 = on a tick). The xx-th tick
 * after the row is then xx minus this many ticks after the row's start.
 */
export function tickPhase(timing: GridTiming, rowPulse: number): number {
  const pos = tickPos(timing, rowPulse);
  return pos - Math.floor(pos + EPS);
}

/** The pulses `ticks` ticks last at the tempo in force at song pulse `pulse`. */
export function pulsesForTicks(
  timing: GridTiming,
  pulse: number,
  ticks: number
): number {
  return ticks / ticksPerPulse(timing, bpmAt(timing, pulse));
}

/** The tick the xx-th tick after a row is, counting from the anchor. */
function tickAfter(ctx: Ctx, row: number, xx: number): number {
  return Math.floor(tickPos(ctx.timing, ctx.base + row * ctx.ppr) + EPS) + xx;
}

/** Where the next row starts on the same tick count as `row`: a tick at that moment runs before the next row. */
function rowEndTick(ctx: Ctx, row: number): number {
  const start = ctx.base + row * ctx.ppr;
  return ticksBetween(ctx.timing, anchorOf(ctx.timing, start), start + ctx.ppr);
}

/** The largest xx for a delay or cut that still fires inside the row (before the next row starts). */
function lastTick(ctx: Ctx, row: number): number {
  return Math.ceil(rowEndTick(ctx, row) - EPS) - 1 - tickAfter(ctx, row, 0);
}

/**
 * The row at or before a pulse and the delay in ticks after it: the xx-th tick after the row that is nearest the
 * pulse. A delay that rounds to 0 is no delay; one that reaches the next row is the next row. With rows that are not
 * a whole number of pulses (5 rows per beat), a pulse within half a pulse of a row counts as on it.
 */
function place(ctx: Ctx, pulse: number): Spot {
  const { ppr } = ctx;
  const slack = Number.isInteger(ppr) ? EPS : 0.5 + EPS;
  const row = Math.floor(pulse / ppr + EPS / ppr);
  const into = pulse - row * ppr;
  if (into <= slack) {
    return { delay: 0, row };
  }
  if (ppr - into <= slack) {
    return { delay: 0, row: row + 1 };
  }
  const tick = Math.round(tickPos(ctx.timing, ctx.base + pulse));
  const delay = tick - tickAfter(ctx, row, 0);
  if (delay <= 0) {
    return { delay: 0, row };
  }
  return tick >= rowEndTick(ctx, row) - EPS
    ? { delay: 0, row: row + 1 }
    : { delay, row };
}

function rowAt(ctx: Ctx, n: number): Row {
  let r = ctx.byRow.get(n);
  if (!r) {
    r = { fx: [], inst: null, note: null, row: n, vol: null };
    ctx.byRow.set(n, r);
  }
  return r;
}

/** Add an effect to a row. At most four fit, and a row has one delay and one cut. */
function addFx(ctx: Ctx, row: Row, fx: Effect) {
  if (fx.type === "delay" || fx.type === "cut") {
    row.fx = row.fx.filter((e) => e.type !== fx.type);
  }
  if (row.fx.length >= MAX_FX) {
    warn(
      ctx,
      `row ${row.row} holds more than ${MAX_FX} effects, one was left out`
    );
    return;
  }
  row.fx.push(fx);
}

function setTicks(ctx: Ctx, row: Row, type: "cut" | "delay", ticks: number) {
  addFx(ctx, row, effectFromByte(type, ticks));
}

/** The volume and instrument last written to a row: a note only repeats them when they change. */
export interface Running {
  inst: string | null;
  volume: number;
}

/** The note on a row with the volume and instrument it needs (the ones that differ from `running`). */
export function setNote(
  r: Row,
  e: Extract<MmlEvent, { type: "note" }>,
  running: Running
) {
  r.note = e.note;
  if (e.volume !== running.volume || r.vol !== null) {
    r.vol = e.volume;
  }
  running.volume = e.volume;
  if (e.inst !== null && (e.inst !== running.inst || r.inst !== null)) {
    r.inst = e.inst;
  }
  running.inst = e.inst ?? running.inst;
}

/** Put the note on its row with the settings it needs; a delay says how late in the row it starts. */
function writeStart(ctx: Ctx, e: NoteEvent, at: Spot, running: Running) {
  const r = rowAt(ctx, at.row);
  setNote(r, e, running);
  for (const fx of e.fx) {
    addFx(ctx, r, fx);
  }
  if (at.delay > 0) {
    setTicks(ctx, r, "delay", at.delay);
  }
}

/** The end of a note, moved after its start when it is shorter than a tick or so. */
function afterStart(ctx: Ctx, at: Spot, off: Spot): Spot {
  if (off.row > at.row || (off.row === at.row && off.delay > at.delay)) {
    return off;
  }
  const delay = at.delay + 1;
  return delay > lastTick(ctx, at.row)
    ? { delay: 0, row: at.row + 1 }
    : { delay, row: at.row };
}

/** A note that lasts to the end of the music: a cut on the last row, on the last tick before the row would end. */
function cutAtEnd(ctx: Ctx, at: Spot, endRow: number) {
  const last = endRow - 1;
  if (last < at.row) {
    return;
  }
  const xx = lastTick(ctx, last);
  if (xx >= 1 && xx > (last === at.row ? at.delay : 0)) {
    setTicks(ctx, rowAt(ctx, last), "cut", xx);
  }
}

/**
 * A note whose end shares a row with the start of the next note (which is delayed): the cut cannot go on that row,
 * where it would also cancel the delayed note, so it goes on the note's own row with the ticks from there. The count
 * keeps running through the rows in between, and must stop before the next note starts.
 */
function cutFromOwnRow(ctx: Ctx, at: Spot, next: Spot, endPulse: number) {
  const nextStart = tickAfter(ctx, next.row, next.delay);
  const tick = Math.min(
    Math.round(tickPos(ctx.timing, ctx.base + endPulse)),
    nextStart - 1
  );
  const xx = tick - tickAfter(ctx, at.row, 0);
  if (xx > at.delay && xx <= MAX_TICKS) {
    setTicks(ctx, rowAt(ctx, at.row), "cut", xx);
  } else {
    warn(
      ctx,
      `a note on row ${at.row} cannot be cut before the next one starts, it keeps sounding until then`
    );
  }
}

/** The end of a note: a note off on a row, a cut after it when it falls between rows, or nothing when another note takes over. */
function writeEnd(ctx: Ctx, e: NoteEvent, at: Spot, next: Spot | null) {
  const endPulse = e.pulse + e.gate;
  const off = afterStart(ctx, at, place(ctx, endPulse));
  if (
    next !== null &&
    (next.row < off.row || (next.row === off.row && next.delay <= off.delay))
  ) {
    return;
  }
  if (ctx.endRow !== null && off.row >= ctx.endRow) {
    if (off.row === ctx.endRow && off.delay === 0) {
      cutAtEnd(ctx, at, ctx.endRow);
    }
    return;
  }
  if (next !== null && next.row === off.row) {
    cutFromOwnRow(ctx, at, next, endPulse);
    return;
  }
  const r = rowAt(ctx, off.row);
  if (off.delay > 0) {
    setTicks(ctx, r, "cut", off.delay);
  } else if (r.note === null) {
    r.note = "off";
  }
}

/** Where each note goes; of two notes that land on one row the later one wins, and the earlier is left out. */
function planNotes(
  ctx: Ctx,
  events: readonly MmlEvent[]
): Map<NoteEvent, { at: Spot; next: Spot | null }> {
  const spots: { at: Spot; e: NoteEvent }[] = [];
  for (const e of events) {
    if (e.type !== "note") {
      continue;
    }
    const at = place(ctx, e.pulse);
    const prev = spots.at(-1);
    if (prev?.at.row === at.row) {
      warn(ctx, `two notes land on row ${at.row}, the later one wins`);
      spots.pop();
    }
    spots.push({ at, e });
  }
  const plan = new Map<NoteEvent, { at: Spot; next: Spot | null }>();
  for (const [i, s] of spots.entries()) {
    plan.set(s.e, { at: s.at, next: spots[i + 1]?.at ?? null });
  }
  return plan;
}

/** A volume, instrument or pan change: on the row of the note it comes with, else on the row it falls in. */
function writeChange(ctx: Ctx, e: MmlEvent, withNote: boolean) {
  if (e.type !== "volume" && e.type !== "inst" && e.type !== "pan") {
    return;
  }
  const at = place(ctx, e.pulse);
  if (at.delay > 0 && !withNote) {
    warn(
      ctx,
      `a ${e.type === "inst" ? "instrument" : e.type} change at pulse ${e.pulse} falls between rows and was moved to row ${at.row}`
    );
  }
  const r = rowAt(ctx, at.row);
  if (e.type === "volume") {
    r.vol = e.value;
  } else if (e.type === "inst") {
    r.inst = e.id;
  } else {
    addFx(ctx, r, effectFromByte("pan", mmlPanToByte(e.value)));
  }
}

const pulseKey = (pulse: number): number => Math.round(pulse * 1000);

/**
 * MML as tracker rows at the song's own rows per beat. A note between rows keeps its place with a delay (Gxx) on the
 * row before it, a note end between rows is a cut (Sxx) on the row where it falls. Volume, instrument and pan changes
 * go with the note they come with. Two notes within one row cannot both be kept: the later one wins, with a warning.
 */
export function mmlToRows(
  src: string,
  timing: GridTiming,
  opts: GridOptions = {}
): { issues: Issue[]; loopRow: number | null; rows: Row[] } {
  const parsed = parseMml(src, opts);
  const ppr = PPQ / timing.rowsPerBeat;
  const base = (opts.startRow ?? 0) * ppr;
  const own: GridTiming =
    timing.loopStart === undefined && parsed.loopPulse !== null
      ? {
          ...timing,
          loopStart: base + Math.floor(parsed.loopPulse / ppr + EPS) * ppr,
        }
      : timing;
  const ctx: Ctx = {
    base,
    byRow: new Map(),
    endRow: opts.endRow ?? null,
    issues: [...parsed.issues],
    ppr,
    timing: own,
  };
  const plan = planNotes(ctx, parsed.events);
  const notePulses = new Set<number>();
  for (const e of parsed.events) {
    if (e.type === "note") {
      notePulses.add(pulseKey(e.pulse));
    }
  }
  const running: Running = { inst: null, volume: opts.volume ?? 15 };
  for (const e of parsed.events) {
    if (e.type === "note") {
      const p = plan.get(e);
      if (p) {
        writeStart(ctx, e, p.at, running);
        writeEnd(ctx, e, p.at, p.next);
      }
    } else {
      writeChange(ctx, e, notePulses.has(pulseKey(e.pulse)));
    }
  }
  const loopRow =
    parsed.loopPulse === null ? null : place(ctx, parsed.loopPulse).row;
  const rows = [...ctx.byRow.values()].sort((a, b) => a.row - b.row);
  return { issues: ctx.issues, loopRow, rows };
}
