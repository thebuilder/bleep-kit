/* Merging a channel into the rests of another. A chip with fewer channels than the song cannot play every line, so the
   least important line is written into the rests of one that stays: a note goes where the host is silent, and only
   until the host's next note. What does not fit is counted so it can be reported. */

import type { Row } from "../types.ts";

/** The instrument and volume a channel has at some point, which rows without them inherit. */
export interface PlayState {
  inst: string | null;
  vol: number;
}

export const FULL_VOLUME = 15;
const MAX_FX = 4;

/** Every note row gets its instrument and volume written out, so rows of two channels can be mixed without inheriting wrong. */
function bakeState(
  rows: readonly Row[],
  entry: PlayState
): { exit: PlayState; rows: Row[] } {
  let { inst, vol } = entry;
  const out = rows.map((r) => {
    inst = r.inst ?? inst;
    vol = r.vol ?? vol;
    const copy: Row = { ...r, fx: r.fx.map((f) => ({ ...f })) };
    if (typeof r.note === "number") {
      copy.inst = inst;
      copy.vol = vol;
    }
    return copy;
  });
  return { exit: { inst, vol }, rows: out };
}

/** The state each pattern starts in, following the order (the first time a pattern is reached decides). */
function entryStates(
  order: readonly string[],
  tracks: ReadonlyMap<string, readonly Row[]>,
  start: PlayState
): Map<string, PlayState> {
  const entry = new Map<string, PlayState>();
  let state = start;
  for (const id of order) {
    if (!entry.has(id)) {
      entry.set(id, state);
    }
    state = bakeState(tracks.get(id) ?? [], state).exit;
  }
  return entry;
}

const offRow = (row: number): Row => ({
  fx: [],
  inst: null,
  note: "off",
  row,
  vol: null,
});

/** Which rows of a pattern the host's notes sound through, from each note to the next. */
function busyRows(hostEvents: readonly Row[], length: number): boolean[] {
  const busy: boolean[] = Array.from({ length }, () => false);
  for (const [i, r] of hostEvents.entries()) {
    if (typeof r.note === "number") {
      const end = hostEvents[i + 1]?.row ?? length;
      for (let k = r.row; k < end && k < length; k += 1) {
        busy[k] = true;
      }
    }
  }
  return busy;
}

/** The host rows with the added rows written in: a row both have takes the added note. */
function writeAdded(
  host: readonly Row[],
  added: ReadonlyMap<number, Row>
): Row[] {
  const rows = host.map((r) => ({ ...r }));
  for (const r of added.values()) {
    const same = rows.find((x) => x.row === r.row);
    if (same) {
      same.note = r.note;
      same.inst = r.inst ?? same.inst;
      same.vol = r.vol ?? same.vol;
      same.fx = [...same.fx, ...r.fx].slice(0, MAX_FX);
    } else {
      rows.push({ ...r });
    }
  }
  return rows.sort((a, b) => a.row - b.row);
}

/** The rows of one pattern with the part's notes written into the host's rests. */
function fillIn(
  host: readonly Row[],
  part: readonly Row[],
  length: number
): { fitted: number; rows: Row[]; total: number } {
  const hostEvents = host.filter((r) => r.note !== null);
  const hostRows = new Set(hostEvents.map((r) => r.row));
  const busy = busyRows(hostEvents, length);
  const events = part.filter((r) => r.note !== null);
  const added = new Map<number, Row>();
  let fitted = 0;
  let total = 0;
  for (const [i, p] of events.entries()) {
    if (typeof p.note !== "number") {
      continue;
    }
    total += 1;
    if (busy[p.row] || hostRows.has(p.row)) {
      continue;
    }
    const end = events[i + 1]?.row ?? length;
    const nextHost = hostEvents.find((r) => r.row > p.row)?.row ?? length;
    const stop = Math.min(end, nextHost);
    added.set(p.row, p);
    fitted += 1;
    for (let k = p.row; k < stop; k += 1) {
      busy[k] = true;
    }
    if (stop < length && !hostRows.has(stop) && !added.has(stop)) {
      added.set(stop, offRow(stop));
    }
  }
  return { fitted, rows: writeAdded(host, added), total };
}

export interface MergeJob {
  host: ReadonlyMap<string, readonly Row[]>;
  hostStart: PlayState;
  /** Rows in each pattern, by pattern id. */
  lengths: Record<string, number>;
  order: readonly string[];
  part: ReadonlyMap<string, readonly Row[]>;
  partStart: PlayState;
}

/** The host's tracks with the part merged in; the host's own tracks when not a single note fits. */
export function mergeTracks(job: MergeJob): {
  fitted: number;
  total: number;
  tracks: Map<string, readonly Row[]>;
} {
  const hostEntry = entryStates(job.order, job.host, job.hostStart);
  const partEntry = entryStates(job.order, job.part, job.partStart);
  const tracks = new Map<string, readonly Row[]>();
  let fitted = 0;
  let total = 0;
  for (const id of new Set([...job.host.keys(), ...job.part.keys()])) {
    const host = bakeState(
      job.host.get(id) ?? [],
      hostEntry.get(id) ?? job.hostStart
    ).rows;
    const part = bakeState(
      job.part.get(id) ?? [],
      partEntry.get(id) ?? job.partStart
    ).rows;
    const merged = fillIn(host, part, job.lengths[id] ?? 0);
    fitted += merged.fitted;
    total += merged.total;
    tracks.set(id, merged.rows);
  }
  return { fitted, total, tracks: fitted === 0 ? new Map(job.host) : tracks };
}
