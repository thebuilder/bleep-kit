/* Pitch maths shared by the generators and describeSfx. Slides are in octaves per second, so the pitch at time t is
   start * 2^(slide * t + deltaSlide * t^2 / 2). */
import type { Sfx } from "@bleepkit/core";
import { CEILING_HZ } from "./chips.ts";

type Frequency = Sfx["frequency"];

const SAMPLES = 32;
const MAX_SLIDE = 8;
const MAX_DELTA = 16;

/** Octaves travelled from the start pitch after t seconds. */
export function octavesAt(f: Frequency, t: number): number {
  return f.slide * t + 0.5 * f.deltaSlide * t * t;
}

export function pitchAt(f: Frequency, t: number): number {
  return f.start * 2 ** octavesAt(f, t);
}

/** Seconds until the pitch slides below `min`, or Infinity when it never does (or min is 0). */
export function cutoffTime(f: Frequency, total: number): number {
  if (f.min <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const steps = 256;
  for (let i = 0; i <= steps; i += 1) {
    const t = (total * i) / steps;
    if (pitchAt(f, t) < f.min) {
      return t;
    }
  }
  return Number.POSITIVE_INFINITY;
}

export function totalDuration(env: Sfx["envelope"]): number {
  return env.attack + env.sustain + env.decay;
}

/**
 * How long one run of the pitch path lasts. With `repeat` the envelope and the slide restart every 1/rate seconds, so
 * the path never travels further than one repeat period.
 */
export function pitchWindow(sfx: Sfx): number {
  const total = totalDuration(sfx.envelope);
  return sfx.repeat.rate > 0 ? Math.min(total, 1 / sfx.repeat.rate) : total;
}

/** The sound's real length: the envelope total, or earlier when the pitch floor stops it. */
export function playedDuration(sfx: Sfx): number {
  const total = totalDuration(sfx.envelope);
  return Math.min(total, cutoffTime(sfx.frequency, pitchWindow(sfx)));
}

/**
 * Slide and deltaSlide that travel `octaves` over `seconds`. `curve` is the share of the travel done by acceleration:
 * 0 is a straight glide, positive speeds up (a fall that dives), negative slows down (a rise that eases off).
 * Both are scaled together to stay inside the type limits, so a very fast sweep keeps its shape and simply travels a
 * little less than asked.
 */
export function sweepFor(
  octaves: number,
  seconds: number,
  curve = 0
): { slide: number; deltaSlide: number } {
  const slide = ((1 - curve) * octaves) / seconds;
  const deltaSlide = (2 * curve * octaves) / (seconds * seconds);
  const k = Math.min(
    1,
    MAX_SLIDE / Math.max(Math.abs(slide), 1e-9),
    MAX_DELTA / Math.max(Math.abs(deltaSlide), 1e-9)
  );
  return { deltaSlide: deltaSlide * k, slide: slide * k };
}

export interface FitBounds {
  arpMax?: number;
  /** Lowest and highest arpeggio step in semitones (0 when there is none). */
  arpMin?: number;
  hi?: number;
  /** Lowest and highest Hz the sound may reach (before arpeggio steps). */
  lo: number;
}

function excursion(
  f: Frequency,
  seconds: number
): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (let i = 0; i <= SAMPLES; i += 1) {
    const o = octavesAt(f, (seconds * i) / SAMPLES);
    min = Math.min(min, o);
    max = Math.max(max, o);
  }
  return { max, min };
}

/** Whether the whole pitch path, arpeggio included, already sits inside the bounds. */
export function pathFits(
  f: Frequency,
  seconds: number,
  bounds: FitBounds,
  steps: readonly number[] = []
): boolean {
  const { min, max } = excursion(f, seconds);
  const lo = f.start * 2 ** (min + Math.min(0, ...steps) / 12);
  const hi = f.start * 2 ** (max + Math.max(0, ...steps) / 12);
  return lo >= bounds.lo * 0.999 && hi <= (bounds.hi ?? CEILING_HZ) * 1.001;
}

/** Scale the sweep down when it is wider than the room the chip's range leaves for it. */
function scaleToRoom(f: Frequency, seconds: number, room: number): Frequency {
  const { min, max } = excursion(f, seconds);
  const span = max - min;
  if (span <= room * 0.98 || span <= 0) {
    return f;
  }
  const k = Math.max(0, (room * 0.98) / span);
  return { ...f, deltaSlide: f.deltaSlide * k, slide: f.slide * k };
}

/** Octaves the pitch path reaches below and above the start, arpeggio included. */
function reach(
  f: Frequency,
  seconds: number,
  bounds: FitBounds
): { low: number; high: number } {
  const { min, max } = excursion(f, seconds);
  return {
    high: max + (bounds.arpMax ?? 0) / 12,
    low: min + (bounds.arpMin ?? 0) / 12,
  };
}

/**
 * Keep the whole pitch path (slide, curve and arpeggio) inside the chip's range. First the sweep is scaled down if it
 * is wider than the range, then the start pitch is moved by whole octaves (so note names survive) or, when that cannot
 * fit, by the smallest continuous shift.
 */
export function fitPitch(
  f: Frequency,
  seconds: number,
  bounds: FitBounds
): Frequency {
  const hi = bounds.hi ?? CEILING_HZ;
  const arpSpan = ((bounds.arpMax ?? 0) - (bounds.arpMin ?? 0)) / 12;
  const out = scaleToRoom(f, seconds, Math.log2(hi / bounds.lo) - arpSpan);
  const { low, high } = reach(out, seconds, bounds);
  let { start } = out;
  while (start * 2 ** low < bounds.lo && start * 2 ** high * 2 <= hi) {
    start *= 2;
  }
  while (start * 2 ** high > hi && start * 2 ** low * 0.5 >= bounds.lo) {
    start /= 2;
  }
  start = Math.max(start, bounds.lo / 2 ** low);
  start = Math.min(start, hi / 2 ** high);
  return { ...out, start };
}

/**
 * Pull the slide and deltaSlide back toward zero, keeping the start pitch, until the whole pitch path fits the bounds.
 * Used by mutate, where a nudge must never move the start by octaves. Leaves the sweep alone when even a flat sound at
 * the start pitch would not fit.
 */
export function shrinkToFit(
  f: Frequency,
  seconds: number,
  bounds: FitBounds,
  steps: readonly number[] = []
): Frequency {
  if (pathFits(f, seconds, bounds, steps)) {
    return f;
  }
  const flat = { ...f, deltaSlide: 0, slide: 0 };
  if (!pathFits(flat, seconds, bounds, steps)) {
    return f;
  }
  let good = 0;
  let bad = 1;
  for (let i = 0; i < 14; i += 1) {
    const k = (good + bad) / 2;
    const trial = { ...f, deltaSlide: f.deltaSlide * k, slide: f.slide * k };
    if (pathFits(trial, seconds, bounds, steps)) {
      good = k;
    } else {
      bad = k;
    }
  }
  return { ...f, deltaSlide: f.deltaSlide * good, slide: f.slide * good };
}
