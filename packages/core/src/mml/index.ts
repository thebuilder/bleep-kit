// biome-ignore-all lint/performance/noBarrelFile: the module entry point
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: audio hot paths and long effect switches stay in one function: no call overhead and the order reads like the signal flow
// biome-ignore-all lint/style/useDestructuring: per-sample loops copy fields into locals on purpose, destructuring adds nothing there
import { effectFromByte } from "../normalize/effects.ts";
import type { Effect, Issue, MmlEvent, MmlOptions, Row } from "../types.ts";
import { PPQ } from "../types.ts";
import { MML_PATH, parseMml } from "./parser.ts";

export { formatMml, patternToMml } from "./format.ts";
export type { MmlParse } from "./parser.ts";
export { parseMml } from "./parser.ts";

/** MML pan p0..p15 (8 = center) to the X effect byte: 0x00 left, 0x80 center, 0xFF right. */
export function mmlPanToByte(p: number): number {
  return p <= 8
    ? Math.round((p / 8) * 128)
    : 128 + Math.round(((p - 8) / 7) * 127);
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
  const byRow = new Map<number, Row>();
  const grid = (pulse: number, what: string): number => {
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
  };
  const rowAt = (n: number): Row => {
    let r = byRow.get(n);
    if (!r) {
      r = { fx: [], inst: null, note: null, row: n, vol: null };
      byRow.set(n, r);
    }
    return r;
  };
  let volume = opts.volume ?? 15;
  let inst: string | null = null;
  const events: readonly MmlEvent[] = parsed.events;
  for (let k = 0; k < events.length; k += 1) {
    const e = events[k];
    if (!e) {
      continue;
    }
    if (e.type === "volume") {
      rowAt(grid(e.pulse, "volume change")).vol = e.value;
    } else if (e.type === "inst") {
      rowAt(grid(e.pulse, "instrument change")).inst = e.id;
    } else if (e.type === "pan") {
      const pan: Effect = effectFromByte("pan", mmlPanToByte(e.value));
      rowAt(grid(e.pulse, "pan change")).fx.push(pan);
    } else if (e.type === "note") {
      const r = rowAt(grid(e.pulse, "note"));
      if (typeof r.note === "number") {
        issues.push({
          message: `two notes round to row ${r.row}, the later one wins`,
          path: MML_PATH,
          severity: "warning",
        });
      }
      r.note = e.note;
      if (e.volume !== volume || r.vol !== null) {
        r.vol = e.volume;
      }
      volume = e.volume;
      if (e.inst !== null && (e.inst !== inst || r.inst !== null)) {
        r.inst = e.inst;
      }
      inst = e.inst ?? inst;
      r.fx.push(...e.fx);
      // a note off where the next event is not a note starting at the same row
      const offRow = grid(e.pulse + e.gate, "note end");
      const next = events.slice(k + 1).find((x) => x.type === "note");
      const nextRow = next ? Math.round(next.pulse / pulsesPerRow) : null;
      if (nextRow === null || nextRow > offRow) {
        const off = rowAt(offRow);
        if (off.note === null) {
          off.note = "off";
        }
      }
    }
  }
  const rows = [...byRow.values()].sort((a, b) => a.row - b.row);
  const loopRow =
    parsed.loopPulse === null ? null : grid(parsed.loopPulse, "loop point");
  return { issues, loopRow, rows };
}
