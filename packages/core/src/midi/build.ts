/* Channel events to patterns: cut the song into bar-aligned patterns, write rows (volume and instrument only when they
   change, and always on the first note of a pattern so a pattern plays the same wherever it is reached), reuse
   identical patterns, and attach tempo changes. */

import type { Effect, Pattern, Row } from "../types.ts";
import type { DrumVoice } from "./plan.ts";
import type { ChannelEvent } from "./reduce.ts";

export interface BuiltChannel {
  /** Instrument id for a drum hit (sample chips pick one per drum); null keeps the channel's instrument. */
  drumInstrument: ((voice: DrumVoice) => string) | null;
  events: ChannelEvent[];
  id: string;
  /** False for the NES triangle: it has no volume, and a quiet value would silence it. */
  volume: boolean;
}

export interface PatternPlan {
  /** Pattern ids in play order. */
  order: string[];
  patterns: Record<string, Pattern>;
  /** The row where the song was cut because the order list is full, or null. */
  truncatedAt: number | null;
}

const MAX_ORDER = 256;
const MAX_VOLUME = 15;
const MAX_VELOCITY = 127;

/** MIDI velocity 1..127 to the volume column 1..15 (a played note never becomes silent). */
export function velocityToVolume(velocity: number): number {
  return Math.max(
    1,
    Math.min(MAX_VOLUME, Math.round((velocity / MAX_VELOCITY) * MAX_VOLUME))
  );
}

function noteRow(
  channel: BuiltChannel,
  e: ChannelEvent,
  local: number,
  last: { inst: string | null; vol: number }
): Row {
  const vol = channel.volume ? velocityToVolume(e.velocity) : null;
  const inst =
    channel.drumInstrument && e.drum ? channel.drumInstrument(e.drum) : null;
  const row: Row = {
    fx: [],
    inst: inst !== null && inst !== last.inst ? inst : null,
    note: e.note,
    row: local,
    vol: vol !== null && vol !== last.vol ? vol : null,
  };
  last.inst = inst ?? last.inst;
  last.vol = vol ?? last.vol;
  return row;
}

function channelRows(
  channel: BuiltChannel,
  events: ChannelEvent[],
  start: number
): Row[] {
  const last = { inst: null as string | null, vol: -1 };
  return events.map((e) =>
    e.note === "off"
      ? { fx: [], inst: null, note: "off", row: e.row - start, vol: null }
      : noteRow(channel, e, e.row - start, last)
  );
}

/** Puts tempo effects on the first channel that plays in this pattern (or the first channel), as rows of their own. */
function attachTempo(
  tracks: Record<string, Row[]>,
  host: string,
  tempo: Map<number, Effect>,
  start: number,
  length: number
): void {
  const rows = tracks[host] ?? [];
  for (const [row, fx] of tempo) {
    if (row < start || row >= start + length) {
      continue;
    }
    const local = row - start;
    const existing = rows.find((r) => r.row === local);
    if (existing) {
      existing.fx.push(fx);
    } else {
      rows.push({ fx: [fx], inst: null, note: null, row: local, vol: null });
    }
  }
  rows.sort((a, b) => a.row - b.row);
  if (rows.length > 0) {
    tracks[host] = rows;
  }
}

/** Events of each channel, bucketed by the pattern they fall into. */
function bucket(
  events: ChannelEvent[],
  patternLength: number
): Map<number, ChannelEvent[]> {
  const out = new Map<number, ChannelEvent[]>();
  for (const e of events) {
    const index = Math.floor(e.row / patternLength);
    const list = out.get(index) ?? [];
    list.push(e);
    out.set(index, list);
  }
  return out;
}

export function buildPatterns(opts: {
  channels: BuiltChannel[];
  patternLength: number;
  tempo: Map<number, Effect>;
  totalRows: number;
}): PatternPlan {
  const { channels, patternLength, tempo, totalRows } = opts;
  const buckets = channels.map((c) => bucket(c.events, patternLength));
  const host = channels.find((c) => c.events.length > 0)?.id ?? channels[0]?.id;
  const plan: PatternPlan = { order: [], patterns: {}, truncatedAt: null };
  const seen = new Map<string, string>();
  for (let start = 0; start < totalRows; start += patternLength) {
    if (plan.order.length >= MAX_ORDER) {
      plan.truncatedAt = start;
      break;
    }
    const length = Math.min(patternLength, totalRows - start);
    const index = start / patternLength;
    const tracks: Record<string, Row[]> = {};
    for (const [i, channel] of channels.entries()) {
      const events = buckets[i]?.get(index) ?? [];
      if (events.length > 0) {
        tracks[channel.id] = channelRows(channel, events, start);
      }
    }
    if (host) {
      attachTempo(tracks, host, tempo, start, length);
    }
    const key = `${length}:${JSON.stringify(tracks)}`;
    let id = seen.get(key);
    if (id === undefined) {
      id = `p${Object.keys(plan.patterns).length + 1}`;
      seen.set(key, id);
      plan.patterns[id] = { length, tracks };
    }
    plan.order.push(id);
  }
  return plan;
}
