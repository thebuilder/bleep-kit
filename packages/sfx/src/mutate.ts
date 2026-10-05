/* mutateSfx and mutateMany: small musical nudges. A random subset of the fields moves a little (pitch in whole
   semitones, times by a ratio, levels by a fraction of the category range), nothing leaves the category ranges, and
   amount 0 returns the sound unchanged. The Sfx type has no locked groups, so there is nothing to lock. */
import { deriveSeed, mulberry32, normalizeSfx, type Sfx } from "@bleepkit/core";
import { roundFields } from "./build.ts";
import { CEILING_HZ, CHIP_CAPS, floorHz } from "./chips.ts";
import {
  clampTo,
  FIELD_PATHS,
  type FieldPath,
  type FieldRange,
  getField,
  setField,
} from "./fields.ts";
import {
  type FitBounds,
  pathFits,
  pitchWindow,
  shrinkToFit,
  totalDuration,
} from "./pitch.ts";
import { categoryRanges } from "./ranges.ts";
import { clamp, cloneJson, gauss, pick, type Rng } from "./util.ts";

const DEFAULT_AMOUNT = 0.15;
const TIME_FIELDS: ReadonlySet<FieldPath> = new Set([
  "envelope.attack",
  "envelope.sustain",
  "envelope.decay",
  "arpeggio.rate",
  "vibrato.rate",
  "repeat.rate",
  "fm.indexDecay",
]);
const LOG_FIELDS: ReadonlySet<FieldPath> = new Set([
  "filter.lowpass",
  "filter.highpass",
  "frequency.min",
]);

type Gate = (sfx: Sfx) => boolean;

/** Fields that only mean something under a condition: nudging one of them while it is off would turn an effect on. */
const GATES: Partial<Record<FieldPath, Gate>> = {
  "arpeggio.rate": (s) => s.arpeggio.steps.length > 0 && s.arpeggio.rate > 0,
  "bitcrush.rateDivide": (s) => s.bitcrush.bits !== null,
  "duty.start": (s) => s.wave === "square" && CHIP_CAPS[s.chip].duties === null,
  "duty.sweep": (s) => s.wave === "square" && s.duty.sweep !== 0,
  "filter.highpassSweep": (s) => s.filter.highpassSweep !== 0,
  "filter.lowpassSweep": (s) => s.filter.lowpassSweep !== 0,
  "filter.resonance": (s) => s.filter.lowpass !== null,
  "frequency.min": (s) => s.frequency.min > 0,
  "phaser.offset": (s) => s.phaser.offset !== 0 || s.phaser.sweep !== 0,
  "phaser.sweep": (s) => s.phaser.offset !== 0 || s.phaser.sweep !== 0,
  "repeat.rate": (s) => s.repeat.rate > 0,
  "vibrato.depth": (s) => s.vibrato.depth > 0 && s.vibrato.rate > 0,
  "vibrato.rate": (s) => s.vibrato.depth > 0 && s.vibrato.rate > 0,
};

function isActive(sfx: Sfx, path: FieldPath): boolean {
  return getField(sfx, path) !== null && (GATES[path]?.(sfx) ?? true);
}

function semitoneNudge(rng: Rng, amount: number): number {
  const g = gauss(rng);
  const size = Math.max(1, Math.round(Math.abs(g) * amount * 8));
  return (g < 0 ? -1 : 1) * size;
}

function nudgeValue(
  sfx: Sfx,
  path: FieldPath,
  value: number,
  range: FieldRange,
  rng: Rng,
  amount: number
): number {
  const g = gauss(rng);
  if (path === "frequency.start") {
    return sfx.wave === "noise"
      ? value * 2 ** (g * amount * 0.6)
      : value * 2 ** (semitoneNudge(rng, amount) / 12);
  }
  if (path === "fm.ratio") {
    return value + (g < 0 ? -0.5 : 0.5) * Math.max(1, Math.round(amount * 4));
  }
  if (LOG_FIELDS.has(path)) {
    return value * 2 ** (g * amount * 1.5);
  }
  if (TIME_FIELDS.has(path)) {
    return value * Math.exp(g * amount * 0.6);
  }
  if (range.integer) {
    return value + (g < 0 ? -1 : 1) * Math.max(1, Math.round(amount * 3));
  }
  return value + g * amount * 0.35 * (range.max - range.min);
}

function nudgeDuty(sfx: Sfx, rng: Rng): void {
  const list = CHIP_CAPS[sfx.chip].duties;
  if (!list || list.length < 2) {
    return;
  }
  const at = list.indexOf(sfx.duty.start);
  const next = clamp(
    (at < 0 ? 1 : at) + (rng() < 0.5 ? -1 : 1),
    0,
    list.length - 1
  );
  sfx.duty.start = list[next] ?? sfx.duty.start;
}

function nudgeArpeggio(sfx: Sfx, rng: Rng): void {
  const { steps } = sfx.arpeggio;
  if (steps.length === 0) {
    return;
  }
  const i = Math.floor(rng() * steps.length);
  const shift = (rng() < 0.5 ? -1 : 1) * (rng() < 0.7 ? 1 : 2);
  steps[i] = clamp((steps[i] ?? 0) + shift, -24, 24);
}

function nudgeTable(sfx: Sfx, rng: Rng, amount: number): void {
  const { table } = sfx;
  if (!table) {
    return;
  }
  const edits = 1 + Math.floor(amount * 6);
  for (let k = 0; k < edits; k += 1) {
    const i = Math.floor(rng() * table.length);
    const shift = (rng() < 0.5 ? -1 : 1) * (rng() < 0.7 ? 1 : 2);
    table[i] = clamp((table[i] ?? 0) + shift, 0, 15);
  }
}

/** Fields where 0 means "effect off": a nudge may shrink them but never to nothing. */
const NEVER_ZERO: ReadonlySet<FieldPath> = new Set([
  "arpeggio.rate",
  "frequency.min",
  "repeat.rate",
  "vibrato.depth",
  "vibrato.rate",
]);

/**
 * Where a field may go: the category range, widened to include the value it already has (so a hand-edited value is
 * never snapped), and kept off zero for effect strengths.
 */
function bounds(
  path: FieldPath,
  range: FieldRange,
  original: number
): FieldRange {
  const floor =
    NEVER_ZERO.has(path) && original > 0 ? original * 0.25 : range.min;
  return {
    ...range,
    max: Math.max(range.max, original),
    min: Math.min(Math.max(range.min, floor), original),
  };
}

/**
 * Keep the envelope total under the cap. The excess comes off the sustain first and then the decay, but never below
 * the category range (or the value the sound already had), so trimming cannot push a field out of range.
 */
function capTotal(sfx: Sfx, original: Sfx, max: number): void {
  const { envelope: env } = sfx;
  const { fields } = categoryRanges(sfx.category);
  let excess = totalDuration(env) - max;
  for (const key of ["sustain", "decay"] as const) {
    const floor = Math.min(
      fields[`envelope.${key}`].min,
      original.envelope[key]
    );
    const cut = Math.min(Math.max(0, excess), Math.max(0, env[key] - floor));
    env[key] -= cut;
    excess -= cut;
  }
}

function fitBoundsFor(sfx: Sfx): FitBounds {
  const { steps } = sfx.arpeggio;
  return {
    arpMax: Math.max(0, ...steps),
    arpMin: Math.min(0, ...steps),
    hi: CEILING_HZ,
    lo: floorHz(sfx.chip, sfx.wave),
  };
}

/**
 * Keep the pitch path inside the chip's range. When a nudge pushed it out, give back the nudged slide first, then the
 * nudged start pitch: the sound goes back to values it already had, so it never leaves the category ranges either.
 */
function refit(before: Sfx, after: Sfx): void {
  const total = pitchWindow(after);
  const fit = fitBoundsFor(after);
  const { steps } = after.arpeggio;
  const wasFine = pathFits(
    before.frequency,
    pitchWindow(before),
    fitBoundsFor(before),
    before.arpeggio.steps
  );
  if (wasFine && !pathFits(after.frequency, total, fit, steps)) {
    const keepStart = {
      ...after.frequency,
      deltaSlide: before.frequency.deltaSlide,
      slide: before.frequency.slide,
    };
    after.frequency = pathFits(keepStart, total, fit, steps)
      ? keepStart
      : shrinkToFit({ ...before.frequency }, total, fit, steps);
  }
  if (after.frequency.min > 0) {
    after.frequency.min = Math.min(
      after.frequency.min,
      after.frequency.start * 0.9
    );
  }
}

function chosenPaths(sfx: Sfx, rng: Rng, keep: number): FieldPath[] {
  const active = FIELD_PATHS.filter((path) => isActive(sfx, path));
  const chosen = active.filter(() => rng() < keep);
  if (chosen.length === 0 && active.length > 0) {
    chosen.push(pick(rng, active));
  }
  return chosen;
}

function nudgeOnce(sfx: Sfx, rng: Rng, amount: number, keep: number): Sfx {
  const out = cloneJson(sfx);
  const ranges = categoryRanges(sfx.category).fields;
  for (const path of chosenPaths(sfx, rng, keep)) {
    const value = getField(out, path);
    if (value !== null) {
      const range = bounds(path, ranges[path], value);
      setField(
        out,
        path,
        clampTo(nudgeValue(out, path, value, range, rng, amount), range)
      );
    }
  }
  if (out.wave === "square" && rng() < 0.2 + amount) {
    nudgeDuty(out, rng);
  }
  if (rng() < 0.3 + amount * 0.7) {
    nudgeArpeggio(out, rng);
  }
  if (rng() < 0.3 + amount * 0.7) {
    nudgeTable(out, rng, amount);
  }
  refit(sfx, out);
  roundFields(out);
  capTotal(
    out,
    sfx,
    Math.max(
      categoryRanges(sfx.category).duration.max,
      totalDuration(sfx.envelope)
    )
  );
  roundFields(out);
  return out;
}

/** Last resort when every draw landed on a range edge: move the pitch one semitone the way that stays in range. */
function forceChange(sfx: Sfx): Sfx {
  const out = cloneJson(sfx);
  const range = categoryRanges(sfx.category).fields["frequency.start"];
  const up = out.frequency.start * 2 ** (1 / 12);
  const down = out.frequency.start * 2 ** (-1 / 12);
  out.frequency.start = up <= range.max ? up : Math.max(down, range.min);
  roundFields(out);
  return out;
}

const MAX_ATTEMPTS = 6;

/** A small nudge of a random subset of the fields, deterministic for a seed. `amount` is 0 to 1 (default 0.15). */
export function mutateSfx(
  sfx: Sfx,
  opts: { seed: number; amount?: number }
): Sfx {
  const amount = clamp(opts.amount ?? DEFAULT_AMOUNT, 0, 1);
  if (amount === 0) {
    return normalizeSfx(cloneJson(sfx)).value;
  }
  const rng = mulberry32(deriveSeed(deriveSeed(sfx.seed, "mutate"), opts.seed));
  const before = JSON.stringify(sfx);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const keep = Math.min(1, 0.1 + 0.8 * amount + attempt * 0.15);
    const out = nudgeOnce(sfx, rng, amount, keep);
    if (JSON.stringify(out) !== before) {
      return normalizeSfx(out).value;
    }
  }
  return normalizeSfx(forceChange(sfx)).value;
}

/** A deterministic family of mutants of one sound. */
export function mutateMany(
  sfx: Sfx,
  opts: { seed: number; amount?: number; count: number }
): Sfx[] {
  const family: Sfx[] = [];
  for (let i = 0; i < opts.count; i += 1) {
    const seed = deriveSeed(opts.seed, i);
    family.push(
      opts.amount === undefined
        ? mutateSfx(sfx, { seed })
        : mutateSfx(sfx, { amount: opts.amount, seed })
    );
  }
  return family;
}
