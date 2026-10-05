import { effectFromByte } from "../normalize/effects.ts";
import type { Effect, Issue, MmlEvent, MmlOptions, Row } from "../types.ts";
import { PPQ } from "../types.ts";
import { MML_PATH, parseMml } from "./parser.ts";

export { formatMml, patternToMml } from "./format.ts";

export { parseMml } from "./parser.ts";

/** MML pan p0..p15 (8 = center) to the X effect byte: 0x00 left, 0x80 center, 0xFF right. */
export function mmlPanToByte(p: number): number {
  return p <= 8
    ? Math.round((p / 8) * 128)
    : 128 + Math.round(((p - 8) / 7) * 127);
}

type NoteEvent = Extract<MmlEvent, { type: "note" }>;

/** Tracker rows being filled from MML events: pulses snap to the row grid, finer positions raise a warning. */
interface RowGrid {
  /** The row at a pulse (rounded, with a warning when the pulse is between rows). */
  grid: (pulse: number, what: string) => number;
  /** The row object for a row number, created on first use. */
  rowAt: (n: number) => Row;
  rows: () => Row[];
}

function createRowGrid(pulsesPerRow: number, issues: Issue[]): RowGrid {
  const byRow = new Map<number, Row>();
  return {
    grid(pulse, what) {
      const r = pulse / pulsesPerRow;
      const rounded = Math.round(r);
      if (Math.abs(r - rounded) > 1e-6) {
        issues.push({
          message: `${what} at pulse ${pulse} is finer than a row (${pulsesPerRow} pulses) and was rounded to row ${rounded}`,
          path: MML_PATH,
          severity: "warning",
        });
      }
      return rounded;
    },
    rowAt(n) {
      let r = byRow.get(n);
      if (!r) {
        r = { fx: [], inst: null, note: null, row: n, vol: null };
        byRow.set(n, r);
      }
      return r;
    },
    rows() {
      return [...byRow.values()].sort((a, b) => a.row - b.row);
    },
  };
}

/** The volume and instrument last written to a row: a note only repeats them when they change. */
interface Running {
  inst: string | null;
  volume: number;
}

/** The first note event after index `k`, if any. */
function nextNoteAfter(
  events: readonly MmlEvent[],
  k: number
): NoteEvent | null {
  for (let j = k + 1; j < events.length; j += 1) {
    const x = events[j];
    if (x?.type === "note") {
      return x;
    }
  }
  return null;
}

/** Put a note on its row, with the volume and instrument changes it needs, and the note off that ends it. */
function addNote(
  e: NoteEvent,
  next: NoteEvent | null,
  rows: RowGrid,
  running: Running,
  issues: Issue[],
  pulsesPerRow: number
) {
  const r = rows.rowAt(rows.grid(e.pulse, "note"));
  if (typeof r.note === "number") {
    issues.push({
      message: `two notes round to row ${r.row}, the later one wins`,
      path: MML_PATH,
      severity: "warning",
    });
  }
  r.note = e.note;
  if (e.volume !== running.volume || r.vol !== null) {
    r.vol = e.volume;
  }
  running.volume = e.volume;
  if (e.inst !== null && (e.inst !== running.inst || r.inst !== null)) {
    r.inst = e.inst;
  }
  running.inst = e.inst ?? running.inst;
  r.fx.push(...e.fx);
  // a note off where the next event is not a note starting at the same row
  const offRow = rows.grid(e.pulse + e.gate, "note end");
  const nextRow = next ? Math.round(next.pulse / pulsesPerRow) : null;
  if (nextRow === null || nextRow > offRow) {
    const off = rows.rowAt(offRow);
    if (off.note === null) {
      off.note = "off";
    }
  }
}

/** Convert parsed MML into tracker rows. Events are rounded to the row grid, with a warning when they are finer. */
export function mmlToTrack(
  src: string,
  rowsPerBeat: number,
  opts: MmlOptions = {}
): { rows: Row[]; issues: Issue[]; loopRow: number | null } {
  const parsed = parseMml(src, opts);
  const issues: Issue[] = [...parsed.issues];
  const pulsesPerRow = PPQ / rowsPerBeat;
  const rows = createRowGrid(pulsesPerRow, issues);
  const running: Running = { inst: null, volume: opts.volume ?? 15 };
  const events: readonly MmlEvent[] = parsed.events;
  for (let k = 0; k < events.length; k += 1) {
    const e = events[k];
    if (e?.type === "volume") {
      rows.rowAt(rows.grid(e.pulse, "volume change")).vol = e.value;
    } else if (e?.type === "inst") {
      rows.rowAt(rows.grid(e.pulse, "instrument change")).inst = e.id;
    } else if (e?.type === "pan") {
      const pan: Effect = effectFromByte("pan", mmlPanToByte(e.value));
      rows.rowAt(rows.grid(e.pulse, "pan change")).fx.push(pan);
    } else if (e?.type === "note") {
      addNote(e, nextNoteAfter(events, k), rows, running, issues, pulsesPerRow);
    }
  }
  const loopRow =
    parsed.loopPulse === null
      ? null
      : rows.grid(parsed.loopPulse, "loop point");
  return { issues, loopRow, rows: rows.rows() };
}
