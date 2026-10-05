/* compileSong: patterns and MML merged into one pulse-based event list per channel (section 1.1). The sequencer
   plays this and nothing else. Flow effects (jump, skip, halt) are resolved here by walking the song row by row. */

import { chipChannels } from "../chips/index.ts";
import { mmlPanToByte } from "../mml/index.ts";
import { parseMml } from "../mml/parser.ts";
import { effectByte, effectFromByte } from "../normalize/effects.ts";
import { isMmlOnly } from "../normalize/song.ts";
import type {
  ChipChannel,
  Effect,
  Instrument,
  MmlEvent,
  Pattern,
  Row,
  Song,
} from "../types.ts";
import { PPQ } from "../types.ts";

export type TimelineEvent =
  | {
      type: "note";
      pulse: number;
      note: number;
      inst: string | null;
      vol: number | null;
      fx: Effect[];
      order: number;
      row: number;
    }
  | { type: "off"; pulse: number; order: number; row: number }
  | { type: "release"; pulse: number; order: number; row: number }
  | {
      type: "fx";
      pulse: number;
      fx: Effect[];
      vol: number | null;
      inst: string | null;
      order: number;
      row: number;
    };

/** One row of the played-out song: where it starts and which order entry and row it is. */
export interface RowMark {
  order: number;
  pulse: number;
  row: number;
}

export interface SongTimeline {
  channels: readonly ChipChannel[];
  loopPulse: number | null;
  /** Pulse at which each order entry starts, plus the end pulse as the last entry. */
  orderStarts: number[];
  /** Every row played, in time order (jumps and skips already resolved). The sequencer emits row events from it. */
  rows: RowMark[];
  /** Tempo changes as [pulse, bpm], starting with [0, song.tempo]. */
  tempos: [number, number][];
  totalPulses: number;
  /** Per channel, sorted by pulse: note on/off, instrument, volume, pan and effect changes. */
  tracks: TimelineEvent[][];
}

const EPS = 1e-6;
const MAX_ROW_STEPS = 256 * 256 + 8;
const PRIORITY: Readonly<Record<TimelineEvent["type"], number>> = {
  fx: 2,
  note: 3,
  off: 0,
  release: 1,
};

interface FlowRow {
  halt: boolean;
  jump: number | null;
  skip: number | null;
}

function rowFlow(
  song: Song,
  patternId: string,
  rowIndex: number,
  mmlIds: Set<string>
): FlowRow {
  const flow: FlowRow = { halt: false, jump: null, skip: null };
  const pat = song.patterns[patternId];
  if (!pat) {
    return flow;
  }
  for (const [chId, rows] of Object.entries(pat.tracks)) {
    if (mmlIds.has(chId)) {
      continue;
    }
    const row = rows.find((r) => r.row === rowIndex);
    if (!row) {
      continue;
    }
    for (const e of row.fx) {
      if (e.type === "jump" && flow.jump === null) {
        flow.jump = effectByte(e);
      } else if (e.type === "skip" && flow.skip === null) {
        flow.skip = effectByte(e);
      } else if (e.type === "halt") {
        flow.halt = true;
      }
    }
  }
  return flow;
}

function rowEvents(row: Row, pulse: number, order: number): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  const base = { order, pulse, row: row.row };
  if (typeof row.note === "number") {
    out.push({
      type: "note",
      ...base,
      fx: row.fx.slice(),
      inst: row.inst,
      note: row.note,
      vol: row.vol,
    });
  } else if (row.note === "off") {
    out.push({ type: "off", ...base });
  } else if (row.note === "release") {
    out.push({ type: "release", ...base });
  }
  // an off or release can carry effects, a volume or an instrument too, and so can a row with no note at all
  const carries = row.fx.length > 0 || row.vol !== null || row.inst !== null;
  if (
    carries &&
    (row.note === "off" || row.note === "release" || row.note === null)
  ) {
    out.push({
      type: "fx",
      ...base,
      fx: row.fx.slice(),
      inst: row.inst,
      vol: row.vol,
    });
  }
  return out;
}

function markAt(rows: RowMark[], pulse: number): RowMark {
  let lo = 0;
  let hi = rows.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((rows[mid]?.pulse ?? 0) <= pulse + EPS) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return rows[best] ?? { order: 0, pulse: 0, row: 0 };
}

interface Pending {
  fx: Effect[];
  inst: string | null;
  pulse: number;
  vol: number | null;
}

type NoteEvent = Extract<MmlEvent, { type: "note" }>;

/**
 * The events of one MML channel as the timeline builds them. Volume, instrument and pan changes wait in `pending`
 * until a note at the same pulse takes them along (or the pulse moves on and they go out as an fx event), and a note
 * only carries the volume or instrument that differs from the channel's last one.
 */
class MmlTrack {
  private readonly out: TimelineEvent[] = [];
  private pending: Pending | null = null;
  private lastVol = 15;
  private lastInst: string | null = null;
  private readonly marks: RowMark[];
  private readonly total: number;

  constructor(marks: RowMark[], total: number) {
    this.marks = marks;
    this.total = total;
  }

  /** The first event of a loop carries the channel state, so every pass through the loop starts the same way. */
  forgetState(): void {
    this.lastVol = -1;
    this.lastInst = null;
  }

  /** The pending change at `pulse`, flushing an earlier one first. */
  ensure(pulse: number): Pending {
    if (this.pending && Math.abs(this.pending.pulse - pulse) > EPS) {
      this.flush();
    }
    this.pending ??= { fx: [], inst: null, pulse, vol: null };
    return this.pending;
  }

  note(e: NoteEvent, events: readonly MmlEvent[], index: number): void {
    if (e.pulse >= this.total - EPS) {
      return;
    }
    if (this.pending && Math.abs(this.pending.pulse - e.pulse) > EPS) {
      this.flush();
    }
    const p = this.pending;
    const vol = p?.vol ?? e.volume;
    const inst = p?.inst ?? e.inst;
    const m = markAt(this.marks, e.pulse);
    this.out.push({
      fx: [...(p?.fx ?? []), ...e.fx],
      inst: inst !== null && inst !== this.lastInst ? inst : null,
      note: e.note,
      order: m.order,
      pulse: e.pulse,
      row: m.row,
      type: "note",
      vol: vol === this.lastVol ? null : vol,
    });
    this.lastVol = vol;
    this.lastInst = inst ?? this.lastInst;
    this.pending = null;
    this.noteOff(e.pulse + e.gate, events, index);
  }

  finish(): TimelineEvent[] {
    this.flush();
    return this.out;
  }

  /** The note off at the end of the gate, unless the next note starts right there and takes over. */
  private noteOff(
    offPulse: number,
    events: readonly MmlEvent[],
    index: number
  ): void {
    const next = events.slice(index + 1).find((x) => x.type === "note");
    const nextStartsHere =
      next !== undefined && Math.abs(next.pulse - offPulse) <= EPS;
    if (nextStartsHere || offPulse > this.total + EPS) {
      return;
    }
    const om = markAt(this.marks, Math.min(offPulse, this.total - EPS));
    this.out.push({
      order: om.order,
      pulse: offPulse,
      row: om.row,
      type: "off",
    });
  }

  private flush(): void {
    const p = this.pending;
    if (!p) {
      return;
    }
    const m = markAt(this.marks, p.pulse);
    this.out.push({
      fx: p.fx,
      inst: p.inst,
      order: m.order,
      pulse: p.pulse,
      row: m.row,
      type: "fx",
      vol: p.vol,
    });
    this.pending = null;
  }
}

/** Turn one MML channel into timeline events. */
function mmlEvents(
  src: string,
  loopPulse: number | null,
  total: number,
  marks: RowMark[]
): TimelineEvent[] {
  const { events } = parseMml(src);
  const track = new MmlTrack(marks, total);
  let resync = false;
  for (const [k, e] of events.entries()) {
    if (
      loopPulse !== null &&
      !resync &&
      e.pulse >= loopPulse - EPS &&
      e.type !== "loop"
    ) {
      resync = true;
      track.forgetState();
    }
    if (e.type === "volume") {
      track.ensure(e.pulse).vol = e.value;
    } else if (e.type === "inst") {
      track.ensure(e.pulse).inst = e.id;
    } else if (e.type === "pan") {
      track
        .ensure(e.pulse)
        .fx.push(effectFromByte("pan", mmlPanToByte(e.value)));
    } else if (e.type === "note") {
      track.note(e, events, k);
    }
  }
  return track.finish();
}

/** Which timeline track a channel id writes to, and which channels are MML (their rows are not played from patterns). */
interface Layout {
  channelCount: number;
  channelIndex: Map<string, number>;
  mmlIds: Set<string>;
}

/** What walking the song row by row produces. */
interface RowWalk {
  loopPulse: number | null;
  marks: RowMark[];
  orderStarts: (number | null)[];
  rowCount: number;
  tempos: [number, number][];
  tracks: TimelineEvent[][];
}

interface Position {
  order: number;
  row: number;
}

/** A tempo change; a second one on the same pulse replaces the first. */
function recordTempo(
  tempos: [number, number][],
  pulse: number,
  bpm: number
): void {
  const last = tempos.at(-1);
  if (last && Math.abs(last[0] - pulse) < EPS) {
    last[1] = bpm;
  } else {
    tempos.push([pulse, bpm]);
  }
}

/** The events of one pattern row, in every channel that has one, and its tempo changes. */
function emitRow(
  layout: Layout,
  walk: RowWalk,
  pat: Pattern,
  pos: Position,
  pulse: number
): void {
  for (const [chId, rows] of Object.entries(pat.tracks)) {
    const ci = layout.channelIndex.get(chId);
    if (ci === undefined || layout.mmlIds.has(chId)) {
      continue;
    }
    const r = rows.find((x) => x.row === pos.row);
    if (!r) {
      continue;
    }
    walk.tracks[ci]?.push(...rowEvents(r, pulse, pos.order));
    for (const e of r.fx) {
      if (e.type === "tempo") {
        recordTempo(walk.tempos, pulse, effectByte(e));
      }
    }
  }
}

/** Where the walk goes after `pos`: a jump or skip effect, else the next row, else the next order entry, then the loop. */
function nextPosition(
  song: Song,
  pat: Pattern,
  flow: FlowRow,
  pos: Position
): Position | null {
  if (flow.halt) {
    return null;
  }
  let { order, row } = pos;
  if (flow.jump !== null || flow.skip !== null) {
    order = flow.jump ?? order + 1;
    row = flow.skip ?? 0;
  } else {
    row += 1;
    if (row >= pat.length) {
      row = 0;
      order += 1;
    }
  }
  if (order >= song.order.length) {
    return song.loop === null ? null : { order: song.loop, row: 0 };
  }
  const next = song.patterns[song.order[order] ?? ""];
  return { order, row: next && row >= next.length ? 0 : row };
}

/** Walk the song one row at a time, resolving jump, skip and halt, until it ends or comes back to a row it played. */
function walkRows(song: Song, layout: Layout, ppr: number): RowWalk {
  const walk: RowWalk = {
    loopPulse: null,
    marks: [],
    orderStarts: song.order.map(() => null),
    rowCount: 0,
    tempos: [[0, song.tempo]],
    tracks: Array.from({ length: layout.channelCount }, () => []),
  };
  const visited = new Map<number, number>();
  let pos: Position | null =
    song.order.length === 0 ? null : { order: 0, row: 0 };
  for (let steps = 0; pos && steps < MAX_ROW_STEPS; steps += 1) {
    const pid = song.order[pos.order];
    const pat = pid === undefined ? undefined : song.patterns[pid];
    if (pid === undefined || !pat) {
      break;
    }
    const pulse = walk.rowCount * ppr;
    const key = pos.order * 1024 + pos.row;
    const seen = visited.get(key);
    if (seen !== undefined) {
      walk.loopPulse = seen;
      break;
    }
    visited.set(key, pulse);
    if (pos.row === 0 && walk.orderStarts[pos.order] === null) {
      walk.orderStarts[pos.order] = pulse;
    }
    walk.marks.push({ order: pos.order, pulse, row: pos.row });
    emitRow(layout, walk, pat, pos, pulse);
    walk.rowCount += 1;
    pos = nextPosition(
      song,
      pat,
      rowFlow(song, pid, pos.row, layout.mmlIds),
      pos
    );
  }
  return walk;
}

/** A song written only in MML runs as long as its longest channel and loops where the MML says (or at 0). */
function mmlSpan(
  song: Song,
  ppr: number,
  rowPulses: number
): { loop: number | null; total: number } {
  let end = 0;
  let mmlLoop: number | null = null;
  for (const c of song.channels) {
    if (c.mml !== null) {
      const parsed = parseMml(c.mml);
      end = Math.max(end, parsed.endPulse);
      if (parsed.loopPulse !== null && mmlLoop === null) {
        mmlLoop = parsed.loopPulse;
      }
    }
  }
  const total = end > 0 ? end : Math.min(rowPulses, Math.max(end, ppr));
  return {
    loop: song.loop === null && mmlLoop === null ? null : (mmlLoop ?? 0),
    total,
  };
}

/** Keep the row marks inside the song. */
function trimMarks(marks: RowMark[], totalPulses: number): void {
  while (marks.length > 1 && (marks.at(-1)?.pulse ?? 0) >= totalPulses - EPS) {
    marks.pop();
  }
}

export function compileSong(
  song: Song,
  _instruments: Record<string, Instrument> = {}
): SongTimeline {
  const channels = chipChannels(song);
  const ppr = PPQ / song.rowsPerBeat;
  const layout: Layout = {
    channelCount: channels.length,
    channelIndex: new Map(channels.map((c, i) => [c.id, i])),
    mmlIds: new Set(
      song.channels.filter((c) => c.mml !== null).map((c) => c.id)
    ),
  };
  const walk = walkRows(song, layout, ppr);
  const mmlOnly = isMmlOnly(song);
  let totalPulses = walk.rowCount * ppr;
  let { loopPulse } = walk;
  if (mmlOnly) {
    const span = mmlSpan(song, ppr, totalPulses);
    totalPulses = span.total;
    loopPulse = span.loop;
    trimMarks(walk.marks, totalPulses);
  }

  for (const c of song.channels) {
    const ci = layout.channelIndex.get(c.id);
    if (c.mml !== null && ci !== undefined) {
      const lp = mmlOnly ? loopPulse : null;
      walk.tracks[ci]?.push(...mmlEvents(c.mml, lp, totalPulses, walk.marks));
    }
  }

  for (const t of walk.tracks) {
    t.sort((a, b) => a.pulse - b.pulse || PRIORITY[a.type] - PRIORITY[b.type]);
  }

  const starts: number[] = [];
  let carry = 0;
  for (const s of walk.orderStarts) {
    carry = s ?? carry;
    starts.push(carry);
  }
  starts.push(totalPulses);
  return {
    channels,
    loopPulse,
    orderStarts: starts,
    rows: walk.marks,
    tempos: walk.tempos,
    totalPulses,
    tracks: walk.tracks,
  };
}
