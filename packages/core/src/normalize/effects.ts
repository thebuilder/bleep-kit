/* Tracker effects: the string form ("A0F") and the typed form ({ type, x, y }), and the compact row string
   ("C-4 lead vF A0F") used in song JSON. */

import { noteName, parseNoteName } from "../notes.ts";
import type { Effect, EffectType, Issue, NoteValue, Row } from "../types.ts";
import { EFFECT_TYPES } from "../types.ts";

/** Effect code letter per type (section 2.6). */
const EFFECT_LETTERS: Readonly<Record<EffectType, string>> = {
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

const LETTER_TO_TYPE: Readonly<Record<string, EffectType>> = Object.fromEntries(
  EFFECT_TYPES.map((t) => [EFFECT_LETTERS[t], t])
);

const HEX = "0123456789ABCDEF";
const CODE_RE = /^([0-9A-Za-z])([0-9A-Fa-f])([0-9A-Fa-f])$/;
const STRICT_CODE_RE = /^[0-9A-Z][0-9A-F]{2}$/;
const VOL_RE = /^[vV]([0-9A-Fa-f])$/;
const NOTE_NUMBER = /^[nN](\d{1,3})$/;
const WHITESPACE = /\s+/;
const MAX_FX = 4;

/** "A0F" -> { type: "volSlide", x: 0, y: 15 }. Null when the code is not a known effect. */
export function parseEffect(code: string): Effect | null {
  const m = CODE_RE.exec(code.trim());
  if (!m) {
    return null;
  }
  const type = LETTER_TO_TYPE[(m[1] ?? "").toUpperCase()];
  if (type === undefined) {
    return null;
  }
  return {
    type,
    x: Number.parseInt(m[2] ?? "0", 16),
    y: Number.parseInt(m[3] ?? "0", 16),
  };
}

/** { type: "volSlide", x: 0, y: 15 } -> "A0F". */
export function formatEffect(e: Effect): string {
  const x = HEX[Math.min(15, Math.max(0, Math.round(e.x)))] ?? "0";
  const y = HEX[Math.min(15, Math.max(0, Math.round(e.y)))] ?? "0";
  return `${EFFECT_LETTERS[e.type]}${x}${y}`;
}

/** The one-byte value xx = x * 16 + y of an effect. */
export function effectByte(e: Effect): number {
  return e.x * 16 + e.y;
}

/** Build an effect from a type and a byte. */
export function effectFromByte(type: EffectType, xx: number): Effect {
  const b = Math.min(255, Math.max(0, Math.round(xx)));
  return { type, x: Math.floor(b / 16), y: b % 16 };
}

function parseNoteField(tok: string): NoteValue | undefined {
  const up = tok.toUpperCase();
  if (up === "OFF") {
    return "off";
  }
  if (up === "REL") {
    return "release";
  }
  if (tok === "..." || tok === "." || tok === "--" || tok === "---") {
    return undefined;
  }
  const raw = NOTE_NUMBER.exec(tok);
  if (raw) {
    const n = Number(raw[1]);
    return n <= 127 ? n : undefined;
  }
  const n = parseNoteName(tok);
  return n === null ? undefined : n;
}

function isEmptyToken(tok: string): boolean {
  return tok === "." || tok === "--" || tok === "..." || tok === "---";
}

function looksLikeNote(tok: string): boolean {
  const up = tok.toUpperCase();
  return (
    up === "OFF" ||
    up === "REL" ||
    NOTE_NUMBER.test(tok) ||
    parseNoteName(tok) !== null ||
    isEmptyToken(tok)
  );
}

function rowIssue(
  issues: Issue[],
  message: string,
  severity: Issue["severity"] = "error"
) {
  issues.push({ message, path: "/s", severity });
}

/** The first token of a row string is the note: a name, a number, OFF, REL or an empty marker. */
function readNoteToken(tok: string, out: Row, issues: Issue[]) {
  if (!looksLikeNote(tok)) {
    rowIssue(
      issues,
      `"${tok}" is not a note (use C-4, C#4, n60, OFF, REL or ...)`
    );
    return;
  }
  const n = parseNoteField(tok);
  if (n !== undefined) {
    out.note = n;
  } else if (!isEmptyToken(tok)) {
    rowIssue(issues, `note "${tok}" must be 0 to 127`);
  }
}

/** A trailing field: an effect code, or an empty marker that skips the slot. */
function readEffectToken(tok: string, out: Row, issues: Issue[]) {
  if (isEmptyToken(tok)) {
    return;
  }
  const fx = parseEffect(tok);
  if (!fx) {
    rowIssue(
      issues,
      `"${tok}" is not an effect code (letter then two hex digits, like A0F)`
    );
  } else if (out.fx.length >= MAX_FX) {
    rowIssue(
      issues,
      `a row holds at most ${MAX_FX} effects, "${tok}" was dropped`,
      "warning"
    );
  } else {
    out.fx.push(fx);
  }
}

type RowStage = "inst" | "vol" | "fx";

/**
 * One field after the note: instrument, then volume, then effects. The instrument slot is skipped when the token is
 * a volume or an effect, and so is the volume slot when the token is an effect. Returns the stage of the next field.
 */
function readFieldToken(
  tok: string,
  stage: RowStage,
  out: Row,
  issues: Issue[]
): RowStage {
  let at = stage;
  if (at === "inst") {
    if (isEmptyToken(tok)) {
      return "vol";
    }
    if (!(VOL_RE.test(tok) || STRICT_CODE_RE.test(tok))) {
      out.inst = tok;
      return "vol";
    }
    at = "vol";
  }
  if (at === "vol") {
    if (isEmptyToken(tok)) {
      return "fx";
    }
    const v = VOL_RE.exec(tok);
    if (v) {
      out.vol = Number.parseInt(v[1] ?? "0", 16);
      return "fx";
    }
  }
  readEffectToken(tok, out, issues);
  return "fx";
}

/** Parse "C-4 lead vF A0F" into a Row. Issue paths are relative to the row ("/s" for the string itself). */
export function parseRowString(
  s: string,
  row: number
): { row: Row; issues: Issue[] } {
  const issues: Issue[] = [];
  const out: Row = { fx: [], inst: null, note: null, row, vol: null };
  const toks = s
    .trim()
    .split(WHITESPACE)
    .filter((t) => t.length > 0);
  if (toks.length === 0) {
    rowIssue(issues, "must not be empty");
    return { issues, row: out };
  }
  readNoteToken(toks[0] ?? "", out, issues);
  let stage: RowStage = "inst";
  for (const tok of toks.slice(1)) {
    stage = readFieldToken(tok, stage, out, issues);
  }
  return { issues, row: out };
}

function formatNote(n: NoteValue | null): string {
  if (n === null) {
    return "...";
  }
  if (n === "off") {
    return "OFF";
  }
  if (n === "release") {
    return "REL";
  }
  return noteName(n);
}

/** The compact string for a row, trailing empty fields trimmed: "C-4 lead vF A0F", "OFF", "... . . A0F". */
export function formatRowString(r: Row): string {
  const parts = [
    formatNote(r.note),
    r.inst ?? ".",
    r.vol === null ? "." : `v${HEX[Math.min(15, Math.max(0, r.vol))] ?? "0"}`,
  ];
  for (const e of r.fx) {
    parts.push(formatEffect(e));
  }
  while (parts.length > 1 && parts.at(-1) === ".") {
    parts.pop();
  }
  return parts.join(" ");
}
