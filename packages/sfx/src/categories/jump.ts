/* Jump: a rising glide that eases off at the top, like an arc. Variants: a springy boing with vibrato, an FM hop, and a
   double jump (two quick rising steps). */
import {
  applyWave,
  type Ctx,
  chooseWave,
  drawDuty,
  setEnvelope,
} from "../build.ts";
import { between, chance, logBetween, pick, round } from "../util.ts";
import {
  arpeggio,
  type Flavor,
  noteHz,
  phaser,
  pwm,
  runFlavors,
  slideBy,
  vibrato,
  w,
} from "./flavors.ts";

function hop(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["square", 6],
    ["triangle", 3],
    ["saw", 1],
    ["sine", 1],
    ["wave", 2],
  ]);
  applyWave(ctx, wave, { table: pick(rng, ["triangle", "sine"]) });
  sfx.frequency.start = noteHz(ctx, 48, 62);
  const total = between(rng, 0.14, 0.34);
  const sustain = between(rng, 0.05, 0.16);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.1, 0.3));
  slideBy(ctx, between(rng, 0.7, 1.6), total, between(rng, -0.4, 0));
  sfx.duty.start = drawDuty(ctx, 0.2, 0.5);
  pwm(ctx, 0.4, 1, 3);
  phaser(ctx, 1, 4, 8);
  sfx.volume = round(between(rng, 0.55, 0.75), 2);
}

function spring(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["sine", 4],
    ["triangle", 4],
    ["square", 3],
    ["wave", 1],
  ]);
  applyWave(ctx, wave, { table: "sine" });
  sfx.frequency.start = noteHz(ctx, 43, 57);
  const total = between(rng, 0.25, 0.5);
  const sustain = between(rng, 0.1, 0.25);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0, 0.2));
  slideBy(ctx, between(rng, 0.8, 1.6), total, between(rng, -0.3, 0.1));
  vibrato(ctx, 0.3, 0.8, 12, 20);
  sfx.duty.start = drawDuty(ctx, 0.3, 0.5);
  sfx.volume = round(between(rng, 0.55, 0.75), 2);
}

function fmHop(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  applyWave(ctx, "fm", { fm: pick(rng, ["pluck", "glass", "bass"]) });
  sfx.frequency.start = noteHz(ctx, 50, 64);
  const total = between(rng, 0.14, 0.36);
  const sustain = between(rng, 0.04, 0.16);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.1, 0.3));
  slideBy(ctx, between(rng, 0.7, 1.5), total, between(rng, -0.4, 0));
  if (chance(rng, 0.25)) {
    vibrato(ctx, 0.2, 0.5, 10, 18);
  }
  sfx.volume = round(between(rng, 0.55, 0.75), 2);
}

function doubleJump(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["square", 6],
    ["triangle", 3],
    ["wave", 2],
    ["fm", 4],
    ["sine", 1],
  ]);
  applyWave(ctx, wave, { fm: "pluck", table: "triangle" });
  sfx.frequency.start = noteHz(ctx, 55, 70);
  const step = logBetween(rng, 0.06, 0.1);
  const total = step * between(rng, 2.3, 2.9);
  const sustain = step * between(rng, 1.1, 1.5);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.1, 0.3));
  arpeggio(ctx, [pick(rng, [5, 7, 12])], step);
  slideBy(ctx, between(rng, 0.2, 0.7), total, 0);
  sfx.duty.start = drawDuty(ctx, 0.2, 0.5);
  sfx.volume = round(between(rng, 0.55, 0.75), 2);
}

const FLAVORS: readonly Flavor[] = [
  { build: hop, weights: w(60, 60, 60, 40, 45, 55, 45) },
  { build: spring, weights: w(15, 15, 15, 10, 15, 20, 15) },
  { build: fmHop, weights: w(0, 0, 0, 35, 40, 0, 20) },
  { build: doubleJump, weights: w(15, 15, 15, 15, 15, 15, 15) },
];

export function buildJump(ctx: Ctx): void {
  runFlavors(ctx, FLAVORS);
}
