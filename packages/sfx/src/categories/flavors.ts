/* Building blocks for the category files. A category is a table of flavors (a "pew" and a "beam" are both lasers);
   each flavor has a weight per chip, so an adlib laser leans on FM and an NES laser never touches a filter. */
import { CHIP_IDS, type ChipId, noteToHz } from "@bleepkit/core";
import type { Ctx } from "../build.ts";
import { sweepFor } from "../pitch.ts";
import { between, intBetween, logBetween, round, weighted } from "../util.ts";

export type Builder = (ctx: Ctx) => void;

export interface Flavor {
  build: Builder;
  weights: Readonly<Record<ChipId, number>>;
}

/** Weights in chip order: nes, gameboy, c64, genesis, adlib, snes, custom. */
export function w(
  nes: number,
  gameboy: number,
  c64: number,
  genesis: number,
  adlib: number,
  snes: number,
  custom: number
): Record<ChipId, number> {
  const list = [nes, gameboy, c64, genesis, adlib, snes, custom];
  const out = {} as Record<ChipId, number>;
  for (const [i, id] of CHIP_IDS.entries()) {
    out[id] = list[i] ?? 0;
  }
  return out;
}

export function runFlavors(ctx: Ctx, flavors: readonly Flavor[]): void {
  const entries = flavors
    .map((f) => [f, f.weights[ctx.chip]] as const)
    .filter(([, weight]) => weight > 0);
  const chosen = entries.length > 0 ? weighted(ctx.rng, entries) : flavors[0];
  chosen?.build(ctx);
}

/** A whole MIDI note in a range, as Hz. */
export function noteHz(ctx: Ctx, lo: number, hi: number): number {
  return noteToHz(intBetween(ctx.rng, lo, hi));
}

/** Log-uniform Hz in a range (not musical; for noise rates and rumbles). */
export function freeHz(ctx: Ctx, lo: number, hi: number): number {
  return logBetween(ctx.rng, lo, hi);
}

/** Travel `octaves` over `seconds` (see sweepFor). */
export function slideBy(
  ctx: Ctx,
  octaves: number,
  seconds: number,
  curve = 0
): void {
  const { slide, deltaSlide } = sweepFor(octaves, seconds, curve);
  ctx.sfx.frequency.slide = slide;
  ctx.sfx.frequency.deltaSlide = deltaSlide;
}

/** Same sign flip as a coin toss, for sweeps that may go either way. */
export function sign(ctx: Ctx, upChance = 0.5): 1 | -1 {
  return ctx.rng() < upChance ? 1 : -1;
}

/** Arpeggio at a step length in seconds. */
export function arpeggio(ctx: Ctx, steps: number[], stepSeconds: number): void {
  ctx.sfx.arpeggio = { rate: round(1 / stepSeconds, 2), steps };
}

export function vibrato(
  ctx: Ctx,
  depthLo: number,
  depthHi: number,
  rateLo: number,
  rateHi: number
): void {
  ctx.sfx.vibrato = {
    depth: round(between(ctx.rng, depthLo, depthHi), 2),
    rate: round(between(ctx.rng, rateLo, rateHi), 1),
  };
}

/** Lowpass with a sweep, only on chips that have a filter. */
export function lowpass(
  ctx: Ctx,
  hzLo: number,
  hzHi: number,
  sweepLo: number,
  sweepHi: number,
  resonance: [number, number] = [0.15, 0.5]
): void {
  if (!ctx.caps.filter) {
    return;
  }
  ctx.sfx.filter.lowpass = Math.round(freeHz(ctx, hzLo, hzHi));
  ctx.sfx.filter.lowpassSweep = round(between(ctx.rng, sweepLo, sweepHi), 2);
  ctx.sfx.filter.resonance = round(
    between(ctx.rng, resonance[0], resonance[1]),
    2
  );
}

/** Highpass with a sweep, only on chips that have a filter. */
export function highpass(
  ctx: Ctx,
  hzLo: number,
  hzHi: number,
  sweepLo = 0,
  sweepHi = 0
): void {
  if (!ctx.caps.filter) {
    return;
  }
  ctx.sfx.filter.highpass = Math.round(freeHz(ctx, hzLo, hzHi));
  ctx.sfx.filter.highpassSweep = round(between(ctx.rng, sweepLo, sweepHi), 2);
}

/** Flanger-like shimmer, only on chips that have it (the 16-bit profile stands in for echo). */
export function phaser(
  ctx: Ctx,
  offsetLo: number,
  offsetHi: number,
  sweepAbs: number
): void {
  if (!ctx.caps.phaser) {
    return;
  }
  ctx.sfx.phaser = {
    offset: round(between(ctx.rng, offsetLo, offsetHi), 1),
    sweep: round(sweepAbs * between(ctx.rng, -1, 1), 1),
  };
}

/** Free-duty chips get a pulse width sweep (PWM); chips with a duty list keep it fixed. */
export function pwm(ctx: Ctx, chancePwm: number, lo: number, hi: number): void {
  if (ctx.caps.duties === null && ctx.rng() < chancePwm) {
    ctx.sfx.duty.sweep = round(
      between(ctx.rng, lo, hi) * (ctx.rng() < 0.5 ? -1 : 1),
      2
    );
  }
}
