/* MML formatting: events back to text, and tracker rows back to text. */

import { formatEffect } from "../normalize/effects.ts";
import type { MmlEvent, MmlOptions, Row } from "../types.ts";
import { PPQ } from "../types.ts";
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

/** Length tokens ("4", "8..") for a duration in pulses, as one entry or several that tie or follow each other. */
function lengthTokens(pulses: number): string[] {
  const out: string[] = [];
  let left = pulses;
  let guard = 0;
  while (left > EPS && guard < 64) {
    guard += 1;
    let best: { token: string; value: number } | null = null;
    for (const n of VALID_LENGTHS) {
      for (let dots = 0; dots <= 3; dots += 1) {
        const value = (WHOLE / n) * dotFactor(dots);
        if (
          value <= left + EPS &&
          (best === null || value > best.value + EPS)
        ) {
          best = { token: `${n}${".".repeat(dots)}`, value };
        }
      }
    }
    if (best === null) {
      // shorter than the shortest length: use the shortest so the text still parses
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

/** One pattern track (sparse rows) to MML. A note lasts until the next row that has a note or an off. */
export function patternToMml(
  rows: readonly Row[],
  rowsPerBeat: number
): string {
  const pulsesPerRow = PPQ / rowsPerBeat;
  const events: MmlEvent[] = [];
  const sorted = [...rows].sort((a, b) => a.row - b.row);
  let cursor = 0;
  let volume = 15;
  let inst: string | null = null;
  const endOfNote = (index: number): number => {
    for (let k = index + 1; k < sorted.length; k += 1) {
      const r = sorted[k];
      if (
        r &&
        (typeof r.note === "number" || r.note === "off" || r.note === "release")
      ) {
        return r.row;
      }
    }
    return (sorted[index]?.row ?? 0) + 1;
  };
  for (let idx = 0; idx < sorted.length; idx += 1) {
    const r = sorted[idx];
    if (!r) {
      continue;
    }
    const startPulse = r.row * pulsesPerRow;
    if (r.inst !== null && r.inst !== inst) {
      ({ inst } = r);
      events.push({ id: r.inst, pulse: startPulse, type: "inst" });
    }
    if (r.vol !== null && r.vol !== volume) {
      volume = r.vol;
      events.push({ pulse: startPulse, type: "volume", value: r.vol });
    }
    if (typeof r.note === "number") {
      if (startPulse > cursor + EPS) {
        events.push({
          duration: startPulse - cursor,
          pulse: cursor,
          type: "rest",
        });
      }
      const endRow = endOfNote(idx);
      const duration = (endRow - r.row) * pulsesPerRow;
      events.push({
        duration,
        fx: r.fx,
        gate: duration,
        inst,
        note: r.note,
        pulse: startPulse,
        type: "note",
        volume,
      });
      cursor = startPulse + duration;
    }
  }
  return formatMml(events);
}
