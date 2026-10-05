/* Laser: a fast dive from a high pitch (the "pew"), a longer beam, an FM zap-laser on the FM chips, and a rare rising
   charge. SID gets a lowpass sweep, the 16-bit profile a touch of phaser. */
import {
  applyWave,
  type Ctx,
  chooseWave,
  drawDuty,
  setEnvelope,
} from "../build.ts";
import { between, chance, pick, round } from "../util.ts";
import {
  type Flavor,
  highpass,
  lowpass,
  noteHz,
  phaser,
  pwm,
  runFlavors,
  slideBy,
  vibrato,
  w,
} from "./flavors.ts";

function pew(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["square", 6],
    ["saw", 3],
    ["triangle", 1],
    ["sine", 1],
    ["wave", 1],
  ]);
  applyWave(ctx, wave, { table: pick(rng, ["saw", "triangle", "pulse"]) });
  sfx.frequency.start = noteHz(ctx, 79, 103);
  const total = between(rng, 0.14, 0.4);
  const sustain = between(rng, 0, 0.08);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.2, 0.55));
  slideBy(ctx, -between(rng, 1.5, 3.4), total, between(rng, 0.2, 0.5));
  sfx.duty.start = drawDuty(ctx);
  pwm(ctx, 0.3, 0.5, 2);
  if (chance(rng, 0.2)) {
    vibrato(ctx, 0.2, 0.6, 20, 35);
  }
  if (chance(rng, 0.5)) {
    lowpass(ctx, 3000, 9000, -3, -1, [0.3, 0.7]);
  }
  phaser(ctx, 1, 4, 8);
  sfx.volume = round(between(rng, 0.55, 0.75), 2);
}

function beam(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["saw", 5],
    ["square", 5],
    ["triangle", 1],
    ["wave", 1],
  ]);
  applyWave(ctx, wave, { table: "saw" });
  sfx.frequency.start = noteHz(ctx, 72, 91);
  const total = between(rng, 0.3, 0.6);
  const attack = between(rng, 0.005, 0.03);
  const sustain = between(rng, 0.1, 0.25);
  setEnvelope(
    ctx,
    attack,
    sustain,
    total - attack - sustain,
    between(rng, 0, 0.3)
  );
  slideBy(ctx, -between(rng, 1, 2.2), total, between(rng, -0.2, 0.3));
  sfx.duty.start = drawDuty(ctx);
  pwm(ctx, 0.4, 0.5, 2);
  if (chance(rng, 0.5)) {
    vibrato(ctx, 0.3, 0.8, 8, 16);
  }
  highpass(ctx, 150, 500);
  phaser(ctx, 1, 5, 10);
  sfx.volume = round(between(rng, 0.55, 0.72), 2);
}

function fmLaser(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  applyWave(ctx, "fm", { fm: "zap" });
  sfx.frequency.start = noteHz(ctx, 67, 96);
  const total = between(rng, 0.2, 0.45);
  const sustain = between(rng, 0, 0.1);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.25, 0.55));
  slideBy(ctx, -between(rng, 1.5, 3), total, between(rng, 0.1, 0.4));
  if (chance(rng, 0.25)) {
    vibrato(ctx, 0.2, 0.7, 18, 34);
  }
  sfx.volume = round(between(rng, 0.55, 0.72), 2);
}

function charge(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["saw", 4],
    ["square", 4],
    ["triangle", 1],
    ["fm", 2],
  ]);
  applyWave(ctx, wave, { fm: "pluck", table: "saw" });
  sfx.frequency.start = noteHz(ctx, 55, 74);
  const total = between(rng, 0.25, 0.5);
  const attack = between(rng, 0.03, 0.1);
  setEnvelope(ctx, attack, between(rng, 0.08, 0.2), 0, between(rng, 0, 0.2));
  sfx.envelope.decay = Math.max(0.05, total - attack - sfx.envelope.sustain);
  slideBy(ctx, between(rng, 1, 2.5), total, between(rng, 0, 0.4));
  sfx.duty.start = drawDuty(ctx);
  vibrato(ctx, 0.2, 0.6, 10, 24);
  lowpass(ctx, 500, 1500, 1, 3, [0.3, 0.6]);
  sfx.volume = round(between(rng, 0.55, 0.72), 2);
}

const FLAVORS: readonly Flavor[] = [
  { build: pew, weights: w(60, 60, 45, 30, 30, 45, 40) },
  { build: beam, weights: w(20, 20, 25, 15, 15, 25, 20) },
  { build: fmLaser, weights: w(0, 0, 0, 55, 55, 0, 20) },
  { build: charge, weights: w(10, 10, 15, 10, 10, 10, 10) },
];

export function buildLaser(ctx: Ctx): void {
  runFlavors(ctx, FLAVORS);
}
