/* Block selection for the tracker, as plain functions: take a rectangle of rows and channels out of a pattern, put one
   back (overwriting, clipped to the pattern and the song's channels), clear it, transpose its notes, and turn a block into
   text and back (one line per row, channels separated by " | ", every cell in the grid's own text: "C-4 03 F 4F4").

   A cell is a whole row of one channel: note, instrument, volume and effects. Nothing here touches the DOM or the
   project; the song editor calls these inside one `project.edit` so each operation is one undo step. */
import type { Effect, NoteValue, Pattern, Row } from "./contract.ts";
import { formatEffect, noteName, parseEffect, parseNoteName } from "./core.ts";

/** What a row holds besides its index. */
export interface Cell {
  fx: Effect[];
  inst: string | null;
  note: NoteValue | null;
  vol: number | null;
}

/** A rectangle copied out of a pattern: `cells[channel][row]`, always `channels` by `rows` cells (empty ones included). */
export interface Block {
  cells: Cell[][];
  channels: number;
  rows: number;
}

/** A rectangle of rows and channel indexes, both ends included. */
export interface Rect {
  ch0: number;
  ch1: number;
  row0: number;
  row1: number;
}

export interface Point {
  ch: number;
  row: number;
}

/** The most rows a pattern has (the format's limit), so pasted text can never ask for more. */
const MAX_ROWS = 256;
/** The most channels a chip has. */
const MAX_CHANNELS = 32;
/** A row holds at most four effects. */
const MAX_FX = 4;
const NO_NOTE = "---";
const NOTE_OFF = "===";
const NOTE_RELEASE = "^^^";
const NO_INST = "--";
const UNKNOWN_INST = "??";
const NO_VOL = "-";
const NO_FX = "---";
const LINE_BREAK = /\r?\n/;
const WHITESPACE = /\s+/;
const INST_TOKEN = /^[0-9a-f]{2}$/i;
const VOL_TOKEN = /^[0-9a-f]$/i;
const NONE: ReadonlySet<string> = new Set();

const emptyCell = (): Cell => ({ fx: [], inst: null, note: null, vol: null });

const isEmptyCell = (c: Cell): boolean =>
  c.note === null && c.inst === null && c.vol === null && c.fx.length === 0;

const copyCell = (c: Cell): Cell => ({
  fx: c.fx.map((e) => ({ ...e })),
  inst: c.inst,
  note: c.note,
  vol: c.vol,
});

/* ----- rectangles ----- */

/** The rectangle between two cells, whichever is the top left. */
export function rectBetween(a: Point, b: Point): Rect {
  return {
    ch0: Math.min(a.ch, b.ch),
    ch1: Math.max(a.ch, b.ch),
    row0: Math.min(a.row, b.row),
    row1: Math.max(a.row, b.row),
  };
}

/** The part of `r` inside a pattern of `rows` rows and `channels` channels, or null when none of it is. */
export function clipRect(r: Rect, rows: number, channels: number): Rect | null {
  const out = {
    ch0: Math.max(0, r.ch0),
    ch1: Math.min(channels - 1, r.ch1),
    row0: Math.max(0, r.row0),
    row1: Math.min(rows - 1, r.row1),
  };
  return out.ch0 > out.ch1 || out.row0 > out.row1 ? null : out;
}

/* ----- editing a pattern ----- */

/** Rewrite rows `row0..row1` of one channel's track. `fn` gets the row's current cell (undefined when empty) and returns
 *  the cell to leave there, or null to leave the row as it is. Empty results drop the row; an empty track is removed. */
function rewriteTrack(
  pattern: Pattern,
  chId: string,
  span: { row0: number; row1: number },
  fn: (row: number, prev: Row | undefined) => Cell | null
): void {
  const byRow = new Map<number, Row>();
  for (const r of pattern.tracks[chId] ?? []) {
    byRow.set(r.row, r);
  }
  for (let row = span.row0; row <= span.row1; row += 1) {
    const next = fn(row, byRow.get(row));
    if (next === null) {
      continue;
    }
    if (isEmptyCell(next)) {
      byRow.delete(row);
    } else {
      byRow.set(row, { ...next, row });
    }
  }
  const list = [...byRow.values()].sort((a, b) => a.row - b.row);
  if (list.length > 0) {
    pattern.tracks[chId] = list;
  } else {
    delete pattern.tracks[chId];
  }
}

/** The channels of `rect` (already clipped) that can be written: they exist and are not in `locked`. */
function writable(
  chIds: readonly string[],
  rect: Rect,
  locked: ReadonlySet<string>
): { at: number; id: string }[] {
  const out: { at: number; id: string }[] = [];
  for (let ch = rect.ch0; ch <= rect.ch1; ch += 1) {
    const id = chIds[ch];
    if (id !== undefined && !locked.has(id)) {
      out.push({ at: ch, id });
    }
  }
  return out;
}

/** Copy `rect` out of a song. `maps[channel]` holds that channel's rows by row index (a channel kept as text has them
 *  compiled from its MML); a channel with no map copies as empty. */
export function extractBlock(
  maps: readonly (ReadonlyMap<number, Row> | undefined)[],
  rect: Rect
): Block {
  const cells: Cell[][] = [];
  for (let ch = rect.ch0; ch <= rect.ch1; ch += 1) {
    const column: Cell[] = [];
    for (let row = rect.row0; row <= rect.row1; row += 1) {
      const r = maps[ch]?.get(row);
      column.push(r ? copyCell(r) : emptyCell());
    }
    cells.push(column);
  }
  return {
    cells,
    channels: rect.ch1 - rect.ch0 + 1,
    rows: rect.row1 - rect.row0 + 1,
  };
}

/** Put `block` into `pattern` with its top left at `at`, overwriting what is there (empty cells too). What does not fit
 *  the pattern's length or the channels is left out, and so are channels in `locked`. Returns the rectangle covered, or
 *  null when `at` is outside the pattern. */
export function pasteBlock(
  pattern: Pattern,
  chIds: readonly string[],
  block: Block,
  at: Point,
  locked: ReadonlySet<string> = NONE
): Rect | null {
  const rect = clipRect(
    {
      ch0: at.ch,
      ch1: at.ch + block.channels - 1,
      row0: at.row,
      row1: at.row + block.rows - 1,
    },
    pattern.length,
    chIds.length
  );
  if (!rect) {
    return null;
  }
  for (const { at: ch, id } of writable(chIds, rect, locked)) {
    const column = block.cells[ch - at.ch] ?? [];
    rewriteTrack(pattern, id, rect, (row) => {
      const cell = column[row - at.row];
      return cell ? copyCell(cell) : emptyCell();
    });
  }
  return rect;
}

/** Empty every cell of `rect` (clipped to the pattern), except in the channels in `locked`. */
export function clearRect(
  pattern: Pattern,
  chIds: readonly string[],
  rect: Rect,
  locked: ReadonlySet<string> = NONE
): void {
  const clipped = clipRect(rect, pattern.length, chIds.length);
  if (!clipped) {
    return;
  }
  for (const { id } of writable(chIds, clipped, locked)) {
    rewriteTrack(pattern, id, clipped, (_row, prev) =>
      prev ? emptyCell() : null
    );
  }
}

/** Move every note of `rect` by `semitones`, held inside 0..127. Note offs, releases and empty cells stay. Returns how
 *  many notes were in the rectangle. */
export function transposeRect(
  pattern: Pattern,
  chIds: readonly string[],
  rect: Rect,
  semitones: number,
  locked: ReadonlySet<string> = NONE
): number {
  const clipped = clipRect(rect, pattern.length, chIds.length);
  if (!clipped) {
    return 0;
  }
  let notes = 0;
  for (const { id } of writable(chIds, clipped, locked)) {
    rewriteTrack(pattern, id, clipped, (_row, prev) => {
      if (!prev || typeof prev.note !== "number") {
        return null;
      }
      notes += 1;
      const note = Math.max(0, Math.min(127, prev.note + semitones));
      return { ...copyCell(prev), note };
    });
  }
  return notes;
}

/* ----- text ----- */

function noteText(n: NoteValue | null): string {
  if (n === null) {
    return NO_NOTE;
  }
  if (n === "off") {
    return NOTE_OFF;
  }
  if (n === "release") {
    return NOTE_RELEASE;
  }
  return noteName(n).padEnd(3, "-");
}

function instText(id: string | null, instIds: readonly string[]): string {
  if (id === null) {
    return NO_INST;
  }
  const at = instIds.indexOf(id);
  return at >= 0
    ? at.toString(16).toUpperCase().padStart(2, "0")
    : UNKNOWN_INST;
}

function cellText(c: Cell, instIds: readonly string[], fxCols: number): string {
  const fx = Array.from({ length: fxCols }, (_, k) => {
    const e = c.fx[k];
    return e ? formatEffect(e) : NO_FX;
  });
  const vol = c.vol === null ? NO_VOL : c.vol.toString(16).toUpperCase();
  return [noteText(c.note), instText(c.inst, instIds), vol, ...fx].join(" ");
}

/** The block as text, as the grid draws it: one line per row, channels separated by " | ". Instruments are written as
 *  their number in `instIds` (the inspector's numbering), "??" for one that is not in the list. */
export function blockToText(block: Block, instIds: readonly string[]): string {
  const fxCols = block.cells.map((column) =>
    Math.max(1, ...column.map((c) => c.fx.length))
  );
  const lines: string[] = [];
  for (let row = 0; row < block.rows; row += 1) {
    lines.push(
      block.cells
        .map((column, ch) =>
          cellText(column[row] ?? emptyCell(), instIds, fxCols[ch] ?? 1)
        )
        .join(" | ")
    );
  }
  return lines.join("\n");
}

function parseNote(tok: string): NoteValue | null | undefined {
  if (tok === NO_NOTE) {
    return null;
  }
  if (tok === NOTE_OFF) {
    return "off";
  }
  if (tok === NOTE_RELEASE) {
    return "release";
  }
  return parseNoteName(tok) ?? undefined;
}

/** One cell's text, or null when it is not a cell. Undefined parts mean "not valid", null parts mean "empty". */
function parseCell(text: string, instIds: readonly string[]): Cell | null {
  const [noteTok, instTok, volTok, ...fxToks] = text.trim().split(WHITESPACE);
  if (noteTok === undefined || instTok === undefined || volTok === undefined) {
    return null;
  }
  const note = parseNote(noteTok);
  const instOk =
    instTok === NO_INST || instTok === UNKNOWN_INST || INST_TOKEN.test(instTok);
  const volOk = volTok === NO_VOL || VOL_TOKEN.test(volTok);
  if (note === undefined || !instOk || !volOk) {
    return null;
  }
  const fx: Effect[] = [];
  for (const tok of fxToks) {
    const e = tok === NO_FX ? null : parseEffect(tok);
    if (tok !== NO_FX && !e) {
      return null;
    }
    if (e) {
      fx.push(e);
    }
  }
  if (fx.length > MAX_FX) {
    return null;
  }
  const inst = INST_TOKEN.test(instTok)
    ? (instIds[Number.parseInt(instTok, 16)] ?? null)
    : null;
  return {
    fx,
    inst,
    note,
    vol: volTok === NO_VOL ? null : Number.parseInt(volTok, 16),
  };
}

/** Read text written by `blockToText` (or typed by hand in the same shape). Null when any line or cell is not in that
 *  shape, so text from elsewhere is never pasted as notes. */
export function textToBlock(
  text: string,
  instIds: readonly string[]
): Block | null {
  const lines = text.trimEnd().split(LINE_BREAK);
  if (lines.length === 0 || lines.length > MAX_ROWS) {
    return null;
  }
  const grid: Cell[][] = [];
  for (const line of lines) {
    const parts = line.split("|");
    if (parts.length > MAX_CHANNELS) {
      return null;
    }
    const row: Cell[] = [];
    for (const part of parts) {
      const cell = parseCell(part, instIds);
      if (!cell) {
        return null;
      }
      row.push(cell);
    }
    if (grid[0] && row.length !== grid[0].length) {
      return null;
    }
    grid.push(row);
  }
  const channels = grid[0]?.length ?? 0;
  const cells = Array.from({ length: channels }, (_, ch) =>
    grid.map((row) => row[ch] ?? emptyCell())
  );
  return { cells, channels, rows: grid.length };
}
