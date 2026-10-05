/* Shared plumbing for the category generators: a blank document, wave and patch helpers, and `finalize`, which makes
   whatever a generator drew safe (inside the type limits, the category duration cap and the chip's pitch range). */
import type { ChipId, Sfx, SfxCategory, SfxWave } from "@bleepkit/core";
import {
  CEILING_HZ,
  CHIP_CAPS,
  type ChipCaps,
  floorHz,
  snapDuty,
} from "./chips.ts";
import {
  clampTo,
  FIELD_PATHS,
  getField,
  setField,
  TYPE_LIMITS,
} from "./fields.ts";
import { fitPitch, pitchAt, pitchWindow, totalDuration } from "./pitch.ts";
import { categoryRanges, DURATIONS } from "./ranges.ts";
import { between, pick, type Rng, round, weighted } from "./util.ts";

export interface Ctx {
  caps: ChipCaps;
  chip: ChipId;
  rng: Rng;
  sfx: Sfx;
}

export function blank(
  category: SfxCategory,
  chip: ChipId,
  seed: number,
  name: string
): Sfx {
  return {
    arpeggio: { rate: 0, steps: [] },
    bitcrush: { bits: null, rateDivide: 1 },
    category,
    chip,
    duty: { start: 0.5, sweep: 0 },
    envelope: { attack: 0, decay: 0.2, punch: 0, sustain: 0.1 },
    filter: {
      highpass: null,
      highpassSweep: 0,
      lowpass: null,
      lowpassSweep: 0,
      resonance: 0,
    },
    fm: null,
    frequency: { deltaSlide: 0, min: 0, slide: 0, start: 440 },
    name,
    noise: { mode: "long" },
    phaser: { offset: 0, sweep: 0 },
    repeat: { rate: 0 },
    seed,
    table: null,
    version: 1,
    vibrato: { depth: 0, rate: 0 },
    volume: 0.7,
    wave: "square",
  };
}

export function makeCtx(rng: Rng, chip: ChipId, sfx: Sfx): Ctx {
  return { caps: CHIP_CAPS[chip], chip, rng, sfx };
}

/** Pick one of the wanted waves that the chip has; falls back to the chip's first wave. */
export function chooseWave(
  ctx: Ctx,
  wanted: readonly (readonly [SfxWave, number])[]
): SfxWave {
  const allowed = wanted.filter(([w]) => ctx.caps.waves.includes(w));
  if (allowed.length === 0) {
    return ctx.caps.waves[0] ?? "square";
  }
  return weighted(ctx.rng, allowed);
}

export type FmKind =
  | "bass"
  | "bell"
  | "glass"
  | "growl"
  | "metal"
  | "pluck"
  | "zap";

const FM_KINDS: Record<
  FmKind,
  {
    ratios: readonly number[];
    index: [number, number];
    decay: [number, number];
  }
> = {
  bass: { decay: [0.1, 0.3], index: [1, 3], ratios: [0.5, 1, 1, 2] },
  bell: { decay: [0.15, 0.5], index: [1.2, 3.5], ratios: [2, 3, 3.5, 4, 5, 7] },
  glass: { decay: [0.2, 0.6], index: [0.3, 1.2], ratios: [1, 2, 3] },
  growl: { decay: [0.3, 1], index: [3, 7], ratios: [0.5, 1, 1.5] },
  metal: {
    decay: [0.1, 0.5],
    index: [3, 6.5],
    ratios: [2.5, 3.5, 5.5, 7, 9.5],
  },
  pluck: { decay: [0.05, 0.2], index: [1.5, 3.5], ratios: [1, 1, 2, 3] },
  zap: { decay: [0.05, 0.25], index: [3.5, 7.5], ratios: [2, 3, 4, 5, 7, 8.5] },
};

function fmPatch(rng: Rng, kind: FmKind): NonNullable<Sfx["fm"]> {
  const k = FM_KINDS[kind];
  return {
    index: round(between(rng, k.index[0], k.index[1]), 2),
    indexDecay: round(between(rng, k.decay[0], k.decay[1]), 2),
    ratio: pick(rng, k.ratios),
  };
}

export type TableKind =
  | "buzz"
  | "organ"
  | "pulse"
  | "saw"
  | "sine"
  | "triangle";

const TABLE_LENGTH = 32;

function tableValue(kind: TableKind, i: number, rng: Rng): number {
  const phase = (i / TABLE_LENGTH) * Math.PI * 2;
  switch (kind) {
    case "sine":
      return 7.5 + 7.5 * Math.sin(phase);
    case "triangle":
      return 15 * (1 - Math.abs((i / TABLE_LENGTH) * 2 - 1));
    case "saw":
      return Math.floor(i / 2);
    case "pulse":
      return i < 8 ? 15 : 0;
    case "organ":
      return (
        7.5 +
        4.5 * Math.sin(phase) +
        2 * Math.sin(2 * phase) +
        1.2 * Math.sin(3 * phase)
      );
    default:
      return Math.floor(rng() * 16);
  }
}

/** A 32-step, 4-bit table for the wave channel. */
function waveTable(rng: Rng, kind: TableKind): number[] {
  const out: number[] = [];
  for (let i = 0; i < TABLE_LENGTH; i += 1) {
    out.push(Math.max(0, Math.min(15, Math.round(tableValue(kind, i, rng)))));
  }
  return out;
}

/** Set the wave and the patch block it needs (fm patch or table), nulling the other. */
export function applyWave(
  ctx: Ctx,
  wave: SfxWave,
  kinds: { fm?: FmKind; table?: TableKind } = {}
): void {
  ctx.sfx.wave = wave;
  ctx.sfx.fm = wave === "fm" ? fmPatch(ctx.rng, kinds.fm ?? "bell") : null;
  ctx.sfx.table =
    wave === "wave" ? waveTable(ctx.rng, kinds.table ?? "triangle") : null;
}

/** Pulse duty drawn from the chip's list (or a free value where the chip has none). */
export function drawDuty(ctx: Ctx, freeLo = 0.12, freeHi = 0.5): number {
  const list = ctx.caps.duties;
  if (list) {
    return pick(ctx.rng, list);
  }
  return round(between(ctx.rng, freeLo, freeHi), 2);
}

const MIN_DECAY = 0.02;

export function setEnvelope(
  ctx: Ctx,
  attack: number,
  sustain: number,
  decay: number,
  punch: number
): void {
  // A decay shorter than this clicks; it is taken from the sustain when the draw left too little.
  const decayFloor = Math.min(MIN_DECAY, attack + sustain + decay);
  const short = Math.max(0, decayFloor - decay);
  ctx.sfx.envelope = {
    attack,
    decay: decay + short,
    punch,
    sustain: Math.max(0, sustain - short),
  };
}

function capDuration(sfx: Sfx, max: number): void {
  const env = sfx.envelope;
  const excess = totalDuration(env) - max;
  if (excess <= 0) {
    return;
  }
  const fromDecay = Math.min(excess, env.decay * 0.7);
  env.decay -= fromDecay;
  const rest = excess - fromDecay;
  if (rest > 0) {
    env.sustain = Math.max(0, env.sustain - rest);
  }
}

function sanitizeStopPitch(sfx: Sfx, total: number): void {
  const f = sfx.frequency;
  if (f.min <= 0) {
    return;
  }
  // The pitch floor must not cut the sound before 60 percent of its length, and never sit above the start.
  f.min = Math.min(f.min, pitchAt(f, total * 0.6) * 0.9, f.start * 0.9);
}

export function roundFields(sfx: Sfx): void {
  for (const path of FIELD_PATHS) {
    const v = getField(sfx, path);
    if (v !== null) {
      setField(sfx, path, round(v, path === "frequency.start" ? 2 : 3));
    }
  }
}

/** The last word on every number: inside the type limits and inside the category's own ranges. */
function clampFields(sfx: Sfx): void {
  const { fields } = categoryRanges(sfx.category);
  for (const path of FIELD_PATHS) {
    const v = getField(sfx, path);
    if (v !== null) {
      const typed = clampTo(v, TYPE_LIMITS[path]);
      setField(sfx, path, clampTo(typed, fields[path]));
    }
  }
}

/** Output level of a full-volume sound on each chip, relative to the NES (measured with renderSfx). */
const CHIP_GAIN: Readonly<Record<ChipId, number>> = {
  adlib: 1.5,
  c64: 1.4,
  custom: 1.45,
  gameboy: 1,
  genesis: 1.5,
  nes: 1,
  snes: 1.5,
};
const MAX_VOLUME = 0.95;

/**
 * A highpass that sits near a tonal sound's pitch removes the sound, not just its low end: keep it well below the
 * lowest pitch the sound reaches, and drop it when that leaves nothing between it and the 20 Hz floor.
 */
function limitHighpass(sfx: Sfx): void {
  const { filter } = sfx;
  if (sfx.wave === "noise" || filter.highpass === null) {
    return;
  }
  const low =
    sfx.frequency.start *
    2 **
      Math.min(
        0,
        sfx.arpeggio.steps.length > 0
          ? Math.min(0, ...sfx.arpeggio.steps) / 12
          : 0
      );
  const limit = Math.min(filter.highpass, low * 0.4);
  filter.highpass = limit < 40 ? null : limit;
  if (filter.highpass === null) {
    filter.highpassSweep = 0;
  }
}

/**
 * The phaser adds a delayed copy, which cancels any pitch whose half period equals the delay. A tonal sound keeps its
 * delay under an eighth of the period of the highest pitch it reaches (the comb then only colors it); noise has no pitch to
 * cancel, so it keeps whatever was drawn. A delay too small to hear is dropped.
 */
function limitPhaser(sfx: Sfx, seconds: number): void {
  const { phaser } = sfx;
  if (sfx.wave === "noise" || (phaser.offset === 0 && phaser.sweep === 0)) {
    return;
  }
  const { steps } = sfx.arpeggio;
  const top =
    Math.max(pitchAt(sfx.frequency, 0), pitchAt(sfx.frequency, seconds)) *
    2 ** ((steps.length > 0 ? Math.max(0, ...steps) : 0) / 12) *
    2 ** (sfx.vibrato.depth / 12);
  const limitMs = 125 / top;
  // A negative delay subtracts the copy, which also removes every low pitch: keep tonal phasers additive.
  const offset = Math.abs(phaser.offset);
  const sweep = Math.max(phaser.sweep, -offset / Math.max(seconds, 0.01));
  phaser.offset = offset;
  phaser.sweep = sweep;
  const reach = Math.max(offset, offset + sweep * seconds);
  if (reach <= limitMs) {
    return;
  }
  const k = limitMs / reach;
  if (limitMs < 0.1) {
    sfx.phaser = { offset: 0, sweep: 0 };
    return;
  }
  sfx.phaser = { offset: offset * k, sweep: sweep * k };
}

/** The highest pitch the path reaches at one instant, arpeggio and vibrato included. */
function topPitchAt(sfx: Sfx, t: number): number {
  const { steps } = sfx.arpeggio;
  const arp = steps.length > 0 ? Math.max(0, ...steps) : 0;
  return pitchAt(sfx.frequency, t) * 2 ** ((arp + sfx.vibrato.depth) / 12);
}

const MAX_FILTER_SWEEP = 4;
const NOISE_LOWPASS_FLOOR = 1500;
const NOISE_LOWPASS_END = 1200;

/**
 * A lowpass that closes below a sound's fundamental (or, for noise, below about a kilohertz) leaves almost nothing
 * to hear. Keep it a safe distance above the pitch at the start and the end of the sound; the sweep is adjusted to
 * land there.
 */
function limitLowpass(sfx: Sfx, seconds: number): void {
  const { filter } = sfx;
  if (filter.lowpass === null) {
    return;
  }
  const noise = sfx.wave === "noise";
  const startMin = noise ? NOISE_LOWPASS_FLOOR : 1.6 * topPitchAt(sfx, 0);
  const endMin = noise ? NOISE_LOWPASS_END : 1.4 * topPitchAt(sfx, seconds);
  const t = Math.max(seconds, 0.01);
  const sweep = Math.max(
    -MAX_FILTER_SWEEP,
    Math.min(MAX_FILTER_SWEEP, filter.lowpassSweep)
  );
  // Raise the start so that the end of the sweep still clears the floor, rather than inventing a huge sweep.
  const start = Math.min(
    20_000,
    Math.max(filter.lowpass, startMin, endMin / 2 ** (sweep * t))
  );
  filter.lowpass = start;
  filter.lowpassSweep = sweep;
}

/** Two filters that overlap too little leave almost nothing: keep the highpass well under the lowpass. */
function limitBand(sfx: Sfx): void {
  const { filter } = sfx;
  if (filter.lowpass === null || filter.highpass === null) {
    return;
  }
  const limit = Math.min(filter.highpass, filter.lowpass / 4);
  filter.highpass = limit < 40 ? null : limit;
  if (filter.highpass === null) {
    filter.highpassSweep = 0;
  }
}

/** Filters and the phaser take level out of the sound: give it back so every category stays audible. */
function compensateLevel(sfx: Sfx): void {
  const { filter } = sfx;
  let gain = CHIP_GAIN[sfx.chip];
  if (filter.lowpass !== null) {
    gain *= 1.3;
  }
  if (filter.highpass !== null) {
    gain *= 1.15;
  }
  if (sfx.phaser.offset !== 0 || sfx.phaser.sweep !== 0) {
    gain *= sfx.wave === "noise" ? 1.25 : 1.4;
  }
  sfx.volume = Math.min(MAX_VOLUME, sfx.volume * gain);
}

/**
 * Make the drawn document safe: the duration cap, the pitch path inside the chip's range for this wave, duty snapped
 * to what the chip offers, and every field inside the type limits. Always the last step of a generator.
 */
export function finalize(ctx: Ctx): Sfx {
  const { sfx } = ctx;
  if (!ctx.caps.waves.includes(sfx.wave)) {
    applyWave(ctx, ctx.caps.waves[0] ?? "square");
  }
  capDuration(sfx, DURATIONS[sfx.category].max);
  const total = pitchWindow(sfx);
  const { steps } = sfx.arpeggio;
  sfx.arpeggio.steps = steps.slice(0, 8);
  if (steps.length === 0) {
    sfx.arpeggio.rate = 0;
  }
  sfx.frequency = fitPitch(sfx.frequency, total, {
    arpMax: Math.max(0, ...steps),
    arpMin: Math.min(0, ...steps),
    hi: CEILING_HZ,
    lo: floorHz(ctx.chip, sfx.wave),
  });
  sanitizeStopPitch(sfx, total);
  limitLowpass(sfx, total);
  limitHighpass(sfx);
  limitBand(sfx);
  limitPhaser(sfx, total);
  compensateLevel(sfx);
  sfx.duty.start = snapDuty(ctx.chip, sfx.duty.start);
  roundFields(sfx);
  clampFields(sfx);
  return sfx;
}
