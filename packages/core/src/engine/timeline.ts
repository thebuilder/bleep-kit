// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: audio hot paths and long effect switches stay in one function: no call overhead and the order reads like the signal flow
// biome-ignore-all lint/style/useDestructuring: per-sample loops copy fields into locals on purpose, destructuring adds nothing there
// biome-ignore-all lint/suspicious/noBitwiseOperators: DSP code: LFSR shifts, power-of-two ring masks, integer hashing and flag masks need bit operations
/* compileSong: patterns and MML merged into one pulse-based event list per channel (section 1.1). The sequencer
   plays this and nothing else. Flow effects (jump, skip, halt) are resolved here by walking the song row by row. */

import { chipChannels } from "../chips/index.ts";
import { mmlPanToByte } from "../mml/index.ts";
import { parseMml } from "../mml/parser.ts";
import { effectByte, effectFromByte } from "../normalize/effects.ts";
import { isMmlOnly } from "../normalize/song.ts";
import type { ChipChannel, Effect, Instrument, Row, Song } from "../types.ts";
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
  if (row.note === "off" || row.note === "release") {
    if (row.fx.length > 0 || row.vol !== null || row.inst !== null) {
      out.push({
        type: "fx",
        ...base,
        fx: row.fx.slice(),
        inst: row.inst,
        vol: row.vol,
      });
    }
  } else if (
    row.note === null &&
    (row.fx.length > 0 || row.vol !== null || row.inst !== null)
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

/** Turn one MML channel into timeline events. */
function mmlEvents(
  src: string,
  loopPulse: number | null,
  total: number,
  marks: RowMark[]
): TimelineEvent[] {
  const parsed = parseMml(src);
  const out: TimelineEvent[] = [];
  const events = parsed.events;
  let lastVol = 15;
  let lastInst: string | null = null;
  const hold: { pending: Pending | null } = { pending: null };
  let resync = false;

  const flush = (): void => {
    const p = hold.pending;
    if (!p) {
      return;
    }
    const m = markAt(marks, p.pulse);
    out.push({
      fx: p.fx,
      inst: p.inst,
      order: m.order,
      pulse: p.pulse,
      row: m.row,
      type: "fx",
      vol: p.vol,
    });
    hold.pending = null;
  };
  const ensure = (pulse: number): Pending => {
    if (hold.pending && Math.abs(hold.pending.pulse - pulse) > EPS) {
      flush();
    }
    if (!hold.pending) {
      hold.pending = { fx: [], inst: null, pulse, vol: null };
    }
    return hold.pending;
  };

  for (let k = 0; k < events.length; k += 1) {
    const e = events[k];
    if (!e) {
      continue;
    }
    if (
      loopPulse !== null &&
      !resync &&
      e.pulse >= loopPulse - EPS &&
      e.type !== "loop"
    ) {
      resync = true;
      // Force the first event of the loop to carry the channel state, so every pass starts the same way.
      lastVol = -1;
      lastInst = null;
    }
    if (e.type === "volume") {
      ensure(e.pulse).vol = e.value;
    } else if (e.type === "inst") {
      ensure(e.pulse).inst = e.id;
    } else if (e.type === "pan") {
      ensure(e.pulse).fx.push(effectFromByte("pan", mmlPanToByte(e.value)));
    } else if (e.type === "note") {
      if (e.pulse >= total - EPS) {
        continue;
      }
      let p = hold.pending;
      if (p && Math.abs(p.pulse - e.pulse) > EPS) {
        flush();
        p = null;
      }
      const vol = p?.vol ?? e.volume;
      const inst = p?.inst ?? e.inst;
      const m = markAt(marks, e.pulse);
      out.push({
        fx: [...(p?.fx ?? []), ...e.fx],
        inst: inst !== null && inst !== lastInst ? inst : null,
        note: e.note,
        order: m.order,
        pulse: e.pulse,
        row: m.row,
        type: "note",
        vol: vol === lastVol ? null : vol,
      });
      lastVol = vol;
      lastInst = inst ?? lastInst;
      hold.pending = null;
      const offPulse = e.pulse + e.gate;
      const next = events.slice(k + 1).find((x) => x.type === "note");
      const nextStartsHere =
        next !== undefined && Math.abs(next.pulse - offPulse) <= EPS;
      if (!nextStartsHere && offPulse <= total + EPS) {
        const om = markAt(marks, Math.min(offPulse, total - EPS));
        out.push({
          order: om.order,
          pulse: offPulse,
          row: om.row,
          type: "off",
        });
      }
    }
  }
  flush();
  return out;
}

export function compileSong(
  song: Song,
  _instruments: Record<string, Instrument> = {}
): SongTimeline {
  const channels = chipChannels(song);
  const ppr = PPQ / song.rowsPerBeat;
  const mmlOnly = isMmlOnly(song);
  const channelIndex = new Map<string, number>();
  for (const [i, c] of channels.entries()) {
    channelIndex.set(c.id, i);
  }
  const mmlIds = new Set<string>();
  for (const c of song.channels) {
    if (c.mml !== null) {
      mmlIds.add(c.id);
    }
  }

  const tracks: TimelineEvent[][] = channels.map(() => []);
  const marks: RowMark[] = [];
  const tempos: [number, number][] = [[0, song.tempo]];
  const orderStarts: (number | null)[] = song.order.map(() => null);
  const visited = new Map<number, number>();
  let loopPulse: number | null = null;

  // Walk the song one row at a time, resolving jump, skip and halt.
  let order = 0;
  let row = 0;
  let rowCount = 0;
  let steps = 0;
  let ended = song.order.length === 0;
  while (!ended && steps < MAX_ROW_STEPS) {
    steps += 1;
    const pid = song.order[order];
    const pat = pid === undefined ? undefined : song.patterns[pid];
    if (pid === undefined || !pat) {
      break;
    }
    const key = order * 1024 + row;
    const pulse = rowCount * ppr;
    const seen = visited.get(key);
    if (seen !== undefined) {
      loopPulse = seen;
      break;
    }
    visited.set(key, pulse);
    if (row === 0 && orderStarts[order] === null) {
      orderStarts[order] = pulse;
    }
    marks.push({ order, pulse, row });
    for (const [chId, rows] of Object.entries(pat.tracks)) {
      const ci = channelIndex.get(chId);
      if (ci === undefined || mmlIds.has(chId)) {
        continue;
      }
      const r = rows.find((x) => x.row === row);
      if (!r) {
        continue;
      }
      tracks[ci]?.push(...rowEvents(r, pulse, order));
      for (const e of r.fx) {
        if (e.type === "tempo") {
          const bpm = effectByte(e);
          const last = tempos.at(-1);
          if (last && Math.abs(last[0] - pulse) < EPS) {
            last[1] = bpm;
          } else {
            tempos.push([pulse, bpm]);
          }
        }
      }
    }
    rowCount += 1;
    const flow = rowFlow(song, pid, row, mmlIds);
    if (flow.halt) {
      ended = true;
      break;
    }
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
      if (song.loop === null) {
        ended = true;
      } else {
        order = song.loop;
        row = 0;
      }
    } else {
      const next = song.patterns[song.order[order] ?? ""];
      if (next && row >= next.length) {
        row = 0;
      }
    }
  }

  let totalPulses = rowCount * ppr;
  let mmlLoop: number | null = null;
  if (mmlOnly) {
    let end = 0;
    for (const c of song.channels) {
      if (c.mml !== null) {
        const parsed = parseMml(c.mml);
        end = Math.max(end, parsed.endPulse);
        if (parsed.loopPulse !== null && mmlLoop === null) {
          mmlLoop = parsed.loopPulse;
        }
      }
    }
    totalPulses = Math.min(totalPulses, Math.max(end, ppr));
    if (end > 0) {
      totalPulses = end;
    }
    loopPulse = song.loop === null && mmlLoop === null ? null : (mmlLoop ?? 0);
    // keep row marks inside the song
    while (
      marks.length > 1 &&
      (marks.at(-1)?.pulse ?? 0) >= totalPulses - EPS
    ) {
      marks.pop();
    }
  }

  for (const c of song.channels) {
    if (c.mml === null) {
      continue;
    }
    const ci = channelIndex.get(c.id);
    if (ci === undefined) {
      continue;
    }
    const lp = mmlOnly ? loopPulse : null;
    tracks[ci]?.push(...mmlEvents(c.mml, lp, totalPulses, marks));
  }

  for (const t of tracks) {
    t.sort((a, b) => a.pulse - b.pulse || PRIORITY[a.type] - PRIORITY[b.type]);
  }

  const starts: number[] = [];
  let carry = 0;
  for (const s of orderStarts) {
    carry = s ?? carry;
    starts.push(carry);
  }
  starts.push(totalPulses);
  return {
    channels,
    loopPulse,
    orderStarts: starts,
    rows: marks,
    tempos,
    totalPulses,
    tracks,
  };
}
