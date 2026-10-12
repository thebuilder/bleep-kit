/* MML channels as tracker rows, for the song editor's grid. The MML is compiled with core's `mmlToTrack` (the same
   function the To tracker button uses), once per change of the text or of the rows per beat, and cached: drawing the
   grid, moving the cursor and every playback frame ask for rows, none of them compile. The rows are what To tracker
   would write, so what the grid shows is what converting gives. */
import type { Row, Song } from "./contract.ts";
import { mmlToTrack } from "./core.ts";

const RELEASE_COMMENT = /^;\s*release rows:\s*([\d ]+)$/m;
const CACHE_SIZE = 32;

/** The release marks a conversion to MML left in a comment: an MML note off cannot say "release", the comment can. */
export function withReleaseNote(mml: string, rows: readonly Row[]): string {
  const at = rows.filter((r) => r.note === "release").map((r) => r.row);
  return at.length > 0 ? `${mml}\n; release rows: ${at.join(" ")}` : mml;
}

/** Note offs on the rows the release comment lists become releases again. */
export function restoreReleases(rows: Row[], mml: string): Row[] {
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

/** The song row where an order entry starts: the lengths of the patterns before it. */
export function orderStartRow(
  song: Pick<Song, "order" | "patterns">,
  orderIdx: number
): number {
  let row = 0;
  for (let i = 0; i < orderIdx && i < song.order.length; i += 1) {
    row += song.patterns[song.order[i] ?? ""]?.length ?? 0;
  }
  return row;
}
