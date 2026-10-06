/* Parts: the notes of one MIDI track on one MIDI channel. This module groups a file into parts, reads the `--map`
   selectors, and decides which chip channel plays which part (explicit map first, then automatic). */

import type { Issue } from "../types.ts";
import type { MidiFile, MidiNote } from "./parse.ts";
import type { ChipPlan } from "./plan.ts";

export interface Part {
  /** MIDI channel, 0 based. */
  channel: number;
  /** True for MIDI channel 10, the General MIDI percussion channel. */
  drums: boolean;
  median: number;
  /** Track name from the file, or null. */
  name: string | null;
  notes: MidiNote[];
  /** Distinct start ticks: chords count once, so this measures how much the part has to say. */
  onsets: number;
  /** Short reference used in messages and `--map`: `t2ch1` is track 2, MIDI channel 1 (both counted from 1). */
  ref: string;
  /** Busyness weighted a little towards high parts: the lead is the best score. */
  score: number;
  /** Track index, 0 based. */
  track: number;
}

export interface PartInfo {
  /** MIDI channel 1..16. */
  channel: number;
  drums: boolean;
  highest: number;
  lowest: number;
  name: string | null;
  notes: number;
  onsets: number;
  ref: string;
  /** The chip channel that plays it, or null when the part was dropped. */
  target: string | null;
  /** Track number, counted from 1. */
  track: number;
}

const DRUM_CHANNEL = 9;
const SCORE_SPAN = 36;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function makePart(file: MidiFile, track: number, channel: number): Part {
  const notes = file.notes.filter(
    (n) => n.track === track && n.channel === channel
  );
  const onsets = new Set(notes.map((n) => n.start)).size;
  const mid = median(notes.map((n) => n.note));
  const lift = Math.max(-0.5, Math.min(0.5, (mid - 60) / SCORE_SPAN));
  return {
    channel,
    drums: channel === DRUM_CHANNEL,
    median: mid,
    name: file.tracks.find((t) => t.index === track)?.name ?? null,
    notes,
    onsets,
    ref: `t${track + 1}ch${channel + 1}`,
    score: onsets * (1 + lift),
    track,
  };
}

/** Every (track, channel) pair that carries notes, in file order. */
export function buildParts(file: MidiFile): Part[] {
  const parts: Part[] = [];
  for (const t of file.tracks) {
    for (const channel of t.channels) {
      parts.push(makePart(file, t.index, channel));
    }
  }
  return parts;
}

export function partInfo(part: Part, target: string | null): PartInfo {
  return {
    channel: part.channel + 1,
    drums: part.drums,
    highest: part.notes.reduce((m, n) => Math.max(m, n.note), 0),
    lowest: part.notes.reduce((m, n) => Math.min(m, n.note), 127),
    name: part.name,
    notes: part.notes.length,
    onsets: part.onsets,
    ref: part.ref,
    target,
    track: part.track + 1,
  };
}

/* ---------- map selectors ---------- */

const CHANNEL_SELECTOR = /^(?:ch)?(\d+)$/i;
const TRACK_SELECTOR = /^t(\d+)(?:(?::|\.|ch)(\d+))?$/i;
const SKIP_TARGETS = new Set(["-", "none", "off", "skip"]);

export type Matcher = (part: Part) => boolean;

/** `3` or `ch3`: MIDI channel 3 (1..16). `t2`: track 2. `t2:3`, `t2.3` or `t2ch3`: track 2, channel 3. Null when malformed. */
export function parseSelector(text: string): Matcher | null {
  const key = text.trim();
  const channel = CHANNEL_SELECTOR.exec(key);
  if (channel) {
    const n = Number(channel[1]);
    return n >= 1 && n <= 16 ? (p) => p.channel === n - 1 : null;
  }
  const track = TRACK_SELECTOR.exec(key);
  if (!track) {
    return null;
  }
  const t = Number(track[1]);
  const c = track[2] === undefined ? null : Number(track[2]);
  if (t < 1 || (c !== null && (c < 1 || c > 16))) {
    return null;
  }
  return (p) => p.track === t - 1 && (c === null || p.channel === c - 1);
}

export function isSkipTarget(target: string): boolean {
  return SKIP_TARGETS.has(target.trim().toLowerCase());
}

/**
 * The `--map` text form: `1=pulse1,2=triangle,10=noise`. Selectors are MIDI channels (`10`), tracks (`t3`) or a track's
 * channel (`t3ch2`); targets are chip channel ids, or `-` to leave a part out.
 */
export function parseMidiMap(text: string): {
  issues: Issue[];
  map: Record<string, string>;
} {
  const map: Record<string, string> = {};
  const issues: Issue[] = [];
  for (const entry of text.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") {
      continue;
    }
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (eq <= 0 || value === "") {
      issues.push({
        message: `map entry "${trimmed}" must look like 1=pulse1 (a MIDI channel or track, then a chip channel)`,
        path: "/map",
        severity: "error",
      });
    } else {
      map[key] = value;
    }
  }
  return { issues, map };
}

/* ---------- assignment ---------- */

export interface Assignment {
  /** Parts per chip channel id. */
  byChannel: Map<string, Part[]>;
  /** Parts that did not get a channel, with the reason. */
  dropped: { part: Part; reason: string }[];
}

interface State {
  assignment: Assignment;
  /** Channels already taken, by the map or by an earlier automatic step. */
  taken: Set<string>;
}

function give(state: State, channel: string, part: Part): void {
  const list = state.assignment.byChannel.get(channel) ?? [];
  list.push(part);
  state.assignment.byChannel.set(channel, list);
  state.taken.add(channel);
}

function drop(state: State, part: Part, reason: string): void {
  state.assignment.dropped.push({ part, reason });
}

/** Applies the explicit map; returns the parts it did not touch. */
function applyMap(
  parts: Part[],
  map: Record<string, string>,
  channelIds: readonly string[],
  state: State,
  issues: Issue[]
): Part[] {
  const claimed = new Set<Part>();
  for (const [key, target] of Object.entries(map)) {
    const match = parseSelector(key);
    const skip = isSkipTarget(target);
    if (!match) {
      issues.push({
        message: `map key "${key}" is not a MIDI channel (1 to 16), a track (t2) or a track and channel (t2ch1)`,
        path: "/map",
        severity: "error",
      });
      continue;
    }
    if (!(skip || channelIds.includes(target))) {
      issues.push({
        message: `map target "${target}" is not a channel of this chip (it has ${channelIds.join(", ")})`,
        path: "/map",
        severity: "error",
      });
      continue;
    }
    const matcher: Matcher = match;
    const hits = parts.filter((p) => matcher(p) && !claimed.has(p));
    if (hits.length === 0) {
      issues.push({
        message: `map entry ${key}=${target} matches no part of the file that is still free`,
        path: "/map",
        severity: "warning",
      });
    }
    for (const part of hits) {
      claimed.add(part);
      if (!skip) {
        give(state, target, part);
      }
    }
  }
  return parts.filter((p) => !claimed.has(p));
}

/**
 * The lowest busy candidate, when some part of the file (placed by the map or not) sits clearly above it; null
 * otherwise.
 */
function pickBass(candidates: Part[], all: Part[]): Part | null {
  const most = Math.max(0, ...all.map((p) => p.onsets));
  const busy = candidates.filter((p) => p.onsets >= Math.max(4, most * 0.15));
  const [lowest] = [...busy].sort(
    (a, b) => a.median - b.median || b.onsets - a.onsets
  );
  if (!lowest) {
    return null;
  }
  const above = all.some((p) => p !== lowest && p.median >= lowest.median + 5);
  return above ? lowest : null;
}

function byScore(a: Part, b: Part): number {
  return (
    b.score - a.score ||
    b.onsets - a.onsets ||
    a.track - b.track ||
    a.channel - b.channel
  );
}

function assignDrums(drums: Part[], plan: ChipPlan, state: State): void {
  for (const part of drums) {
    give(state, plan.drums, part);
  }
}

/** Channels melodic parts can still go to, best first: the melodic channels, then the bass and flexible drum channels. */
function spillOrder(
  plan: ChipPlan,
  state: State,
  drumsPresent: boolean
): string[] {
  const order = plan.melodic.filter((c) => !state.taken.has(c));
  if (!state.taken.has(plan.bass)) {
    order.push(plan.bass);
  }
  if (plan.drumsFlex && !drumsPresent && !state.taken.has(plan.drums)) {
    order.push(plan.drums);
  }
  return order;
}

function assignMelodic(
  melodic: Part[],
  all: Part[],
  plan: ChipPlan,
  state: State,
  drumsPresent: boolean
): void {
  let rest = melodic;
  if (!state.taken.has(plan.bass)) {
    const bass = pickBass(melodic, all);
    if (bass) {
      give(state, plan.bass, bass);
      rest = melodic.filter((p) => p !== bass);
    }
  }
  const channels = spillOrder(plan, state, drumsPresent);
  for (const part of [...rest].sort(byScore)) {
    const channel = channels.shift();
    if (channel === undefined) {
      drop(state, part, "there is no free channel left");
    } else {
      give(state, channel, part);
    }
  }
}

/**
 * Decides which chip channel plays which part. The explicit map goes first (its parts may share a channel, and the
 * channel then plays their top note), then every remaining part is placed automatically on the channels the map left
 * free: percussion on the drum channel, the lowest busy part on the bass channel, the busiest high part on the lead
 * channel and the rest on the remaining channels in order of busyness.
 */
export function assignParts(
  parts: Part[],
  plan: ChipPlan,
  channelIds: readonly string[],
  map: Record<string, string>,
  issues: Issue[]
): Assignment {
  const state: State = {
    assignment: { byChannel: new Map(), dropped: [] },
    taken: new Set(),
  };
  const rest = applyMap(parts, map, channelIds, state, issues);
  const drums = rest.filter((p) => p.drums);
  assignDrums(drums, plan, state);
  assignMelodic(
    rest.filter((p) => !p.drums),
    parts.filter((p) => !p.drums),
    plan,
    state,
    state.assignment.byChannel.has(plan.drums)
  );
  return state.assignment;
}
