/* MML and the tracker grid. A channel the converter had to keep as MML (the patterns jump, skip or halt) is shown in
   the grid as read only rows: they are compiled with core's `mmlToTrack` once per change of the text or of the rows per
   beat, and cached, because drawing the grid, moving the cursor and every playback frame ask for rows. The Text view of
   any other channel turns typed text into the rows of one pattern with `textToRows`, which keeps timing between rows
   as a delay (Gxx) and a cut (Sxx). */
import type { Row } from "./contract.ts";
import { type GridTiming, mmlToRows, mmlToTrack, parseMml } from "./core.ts";

const RELEASE_COMMENT = /^;\s*release rows:\s*([\d ]+)$/m;
const CACHE_SIZE = 32;
const MAX_FX = 4;

/** The release marks the Text view leaves in a comment: an MML note off cannot say "release", the comment can. */
export function withReleaseNote(mml: string, rows: readonly Row[]): string {
  const at = rows.filter((r) => r.note === "release").map((r) => r.row);
  return at.length > 0 ? `${mml}\n; release rows: ${at.join(" ")}` : mml;
}

/** Note offs on the rows the release comment lists become releases again (a row the text edit has moved stays a note off). */
function restoreReleases(rows: Row[], mml: string): Row[] {
  const listed = RELEASE_COMMENT.exec(mml)?.[1];
  if (!listed) {
    return rows;
  }
  const at = new Set(listed.split(" ").filter(Boolean).map(Number));
  return rows.map((r) =>
    r.note === "off" && at.has(r.row) ? { ...r, note: "release" } : r
  );
}

const cache = new Map<string, readonly Row[]>();

/** The rows of an MML text over the whole song (row numbers count from the song's first row), sorted. Cached. */
export function compileMmlRows(
  mml: string,
  rowsPerBeat: number
): readonly Row[] {
  const key = `${rowsPerBeat}:${mml}`;
  const hit = cache.get(key);
  if (hit) {
    // most recently used last, so the oldest entry is the first key
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const rows = restoreReleases(mmlToTrack(mml, rowsPerBeat).rows, mml);
  cache.set(key, rows);
  if (cache.size > CACHE_SIZE) {
    cache.delete(cache.keys().next().value as string);
  }
  return rows;
}

/** The rows from `from` up to `from + length`, keyed by row number within that range. */
export function rowsInRange(
  rows: readonly Row[],
  from: number,
  length: number
): Map<number, Row> {
  const out = new Map<number, Row>();
  // binary search for the first row at or after `from`: a long song has thousands of rows and a pattern a few dozen
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((rows[mid]?.row ?? 0) < from) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  for (let i = lo; i < rows.length; i += 1) {
    const r = rows[i] as Row;
    if (r.row >= from + length) {
      break;
    }
    out.set(r.row - from, r);
  }
  return out;
}

const OFFSET_IN_MESSAGE = /offset (\d+)/;

/** What typed text makes of one pattern: its rows, what did not fit and what is wrong with it. */
export interface TextRows {
  /** Rows past the end of the pattern that were left out (bare note offs do not count). */
  dropped: number;
  /** The first parse error: when set, the grid is left alone. */
  error: string | null;
  /** Character offsets of parse errors, for the underline. */
  errorAt: number[];
  /** Rows inside the pattern. */
  rows: Row[];
  /** A note between rows, rounded by the conversion: said, not hidden. */
  warning: string | null;
}

/**
 * The rows that MML text makes in a pattern of `length` rows that starts at song row `startRow`, with the song's
 * `timing`. Parse errors give no rows (the caller keeps the grid).
 */
export function textToRows(
  text: string,
  timing: GridTiming,
  length: number,
  startRow: number
): TextRows {
  const parsed = parseMml(text);
  const errors = parsed.issues.filter((i) => i.severity === "error");
  const errorAt = errors.flatMap((i) => {
    const m = OFFSET_IN_MESSAGE.exec(i.message);
    return m ? [Number(m[1])] : [];
  });
  const first = errors[0] ?? null;
  if (first) {
    return {
      dropped: 0,
      error: first.message,
      errorAt,
      rows: [],
      warning: null,
    };
  }
  const track = mmlToRows(text, timing, { startRow });
  const all = restoreReleases(track.rows, text);
  const dropped = all.filter(
    (r) => r.row >= length && typeof r.note === "number"
  ).length;
  const [grid] = track.issues.slice(parsed.issues.length);
  return {
    dropped,
    error: null,
    errorAt,
    rows: all.filter((r) => r.row < length),
    warning: grid?.message ?? parsed.issues[0]?.message ?? null,
  };
}

const TIMED = new Set(["cut", "delay"]);

/**
 * Text has no row for an effect on a row with no note (a jump, a tempo change): those stay where they were, and on a
 * row the text gives a note or a cut they join it. Delays and cuts are the text's own (its timing says them), so an old
 * one is not kept: it would cut or delay a note the edit has moved.
 */
export function keepEffectRows(old: readonly Row[], next: Row[]): Row[] {
  const byRow = new Map(next.map((r) => [r.row, r]));
  const added: Row[] = [];
  for (const r of old) {
    const fx = r.fx.filter((e) => !TIMED.has(e.type));
    if (r.note !== null || fx.length === 0) {
      continue;
    }
    const into = byRow.get(r.row);
    if (into) {
      into.fx = [
        ...into.fx,
        ...fx.filter((e) => !into.fx.some((x) => x.type === e.type)),
      ].slice(0, MAX_FX);
    } else {
      added.push({ ...r, fx });
    }
  }
  return added.length === 0
    ? next
    : [...next, ...added].sort((a, b) => a.row - b.row);
}
