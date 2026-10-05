/* Pure scheduling math for files mode: loop points to buffer seconds, where a looping source is at a given time,
   fade levels, semitones to playback rate, and seconds to song rows. No Web Audio in here, so Node tests cover it. */

import type { Song } from "@bleepkit/core";
import { clamp } from "./util.ts";

/** Shortest loop section the player will hand to a buffer source (seconds). */
const MIN_LOOP_SECONDS = 0.01;

export interface LoopPlan {
  loop: boolean;
  loopEnd: number;
  /** Seconds into the buffer. */
  loopStart: number;
}

export interface LoopPoints {
  loopEnd: number | null;
  loopStart: number | null;
}

/** Loop settings for an AudioBufferSourceNode. `want` undefined means "loop when the song has a loop section". */
export function planLoop(
  points: LoopPoints,
  bufferSeconds: number,
  want?: boolean
): LoopPlan {
  const hasStart = points.loopStart !== null;
  const hasPoints = hasStart || points.loopEnd !== null;
  const loop = want ?? hasPoints;
  if (!loop) {
    return { loop: false, loopEnd: bufferSeconds, loopStart: 0 };
  }
  const start = clamp(points.loopStart ?? 0, 0, bufferSeconds);
  const end = clamp(points.loopEnd ?? bufferSeconds, 0, bufferSeconds);
  if (end - start < MIN_LOOP_SECONDS) {
    return { loop: true, loopEnd: bufferSeconds, loopStart: 0 };
  }
  return { loop: true, loopEnd: end, loopStart: start };
}

/** Where in the buffer a source started at `offset` is after `elapsed` seconds; null once a non-looping source ended. */
export function bufferPositionAt(
  elapsed: number,
  offset: number,
  plan: LoopPlan,
  bufferSeconds: number
): number | null {
  const position = offset + Math.max(0, elapsed);
  if (!plan.loop) {
    return position < bufferSeconds ? position : null;
  }
  if (position < plan.loopEnd) {
    return position;
  }
  const length = plan.loopEnd - plan.loopStart;
  return plan.loopStart + ((position - plan.loopStart) % length);
}

/** Offset a looping source can start from: inside the intro or the loop, never past the loop end. */
export function startOffset(
  startAt: number | undefined,
  plan: LoopPlan,
  bufferSeconds: number
): number {
  const wanted = Math.max(0, startAt ?? 0);
  if (plan.loop) {
    return wanted < plan.loopEnd ? wanted : plan.loopStart;
  }
  return Math.min(wanted, bufferSeconds);
}

/** A level moving linearly from `from` to `to`; the player keeps one per gain node so a fade can be interrupted. */
export interface Ramp {
  duration: number;
  from: number;
  start: number;
  to: number;
}

export function rampLevel(ramp: Ramp, now: number): number {
  if (ramp.duration <= 0 || now >= ramp.start + ramp.duration) {
    return ramp.to;
  }
  if (now <= ramp.start) {
    return ramp.from;
  }
  const t = (now - ramp.start) / ramp.duration;
  return ramp.from + (ramp.to - ramp.from) * t;
}

export function semitonesToRate(semitones: number): number {
  return 2 ** (clamp(semitones, -48, 48) / 12);
}

/** Convert seconds into a song to an order index and row at the song's tempo (tempo changes are ignored). */
export function secondsToPosition(
  song: Pick<Song, "tempo" | "rowsPerBeat" | "order" | "patterns" | "loop">,
  seconds: number
): { order: number; row: number } {
  const rowSeconds = 60 / (song.tempo * song.rowsPerBeat);
  let rows = Math.max(0, Math.floor(seconds / rowSeconds));
  const lengths = song.order.map((id) => song.patterns[id]?.length ?? 0);
  const total = lengths.reduce((sum, n) => sum + n, 0);
  if (total === 0) {
    return { order: 0, row: 0 };
  }
  if (rows >= total) {
    const loopFrom = song.loop ?? 0;
    const head = lengths.slice(0, loopFrom).reduce((sum, n) => sum + n, 0);
    const section = total - head;
    rows = section > 0 ? head + ((rows - head) % section) : total - 1;
  }
  for (let order = 0; order < lengths.length; order += 1) {
    const length = lengths[order] ?? 0;
    if (rows < length) {
      return { order, row: rows };
    }
    rows -= length;
  }
  return { order: 0, row: 0 };
}
