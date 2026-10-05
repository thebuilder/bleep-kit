/* Coin and pickup: a bright note that jumps up a fourth or fifth (the Mario and arcade coin), a ringing FM or sine
   bell, and a quick upward chirp. The two-step coin is a base note plus one arpeggio step, so it is exactly two notes
   long: the envelope total is kept under three steps. */
import {
  applyWave,
  type Ctx,
  chooseWave,
  drawDuty,
  setEnvelope,
} from "../build.ts";
import { between, logBetween, pick, round, weighted } from "../util.ts";
import {
  arpeggio,
  type Flavor,
  noteHz,
  phaser,
  pwm,
  runFlavors,
  slideBy,
  w,
} from "./flavors.ts";

const JUMPS = [
  [5, 3],
  [7, 3],
  [4, 2],
  [12, 1],
  [9, 1],
] as const;

function twoStep(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["square", 6],
    ["triangle", 1.5],
    ["wave", 1.5],
    ["sine", 1],
    ["saw", 0.5],
  ]);
  applyWave(ctx, wave, { table: pick(rng, ["sine", "triangle", "organ"]) });
  sfx.frequency.start = noteHz(ctx, 79, 91);
  const step = logBetween(rng, 0.055, 0.17);
  const total = step * between(rng, 2.3, 2.9);
  const sustain = step * between(rng, 1.15, 1.6);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.25, 0.6));
  arpeggio(
    ctx,
    [
      weighted(
        rng,
        JUMPS.map(([n, k]) => [n, k] as const)
      ),
    ],
    step
  );
  sfx.duty.start = drawDuty(ctx);
  pwm(ctx, 0.2, 0.4, 1.2);
  sfx.volume = round(between(rng, 0.55, 0.75), 2);
}

function bell(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["fm", 6],
    ["sine", 2],
    ["triangle", 1.5],
  ]);
  applyWave(ctx, wave, { fm: pick(rng, ["bell", "glass", "pluck"]) });
  sfx.frequency.start = noteHz(ctx, 81, 91);
  setEnvelope(
    ctx,
    0,
    between(rng, 0, 0.04),
    between(rng, 0.3, 0.7),
    between(rng, 0.2, 0.4)
  );
  phaser(ctx, 2, 8, 12);
  sfx.volume = round(between(rng, 0.55, 0.75), 2);
}

function chirp(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["square", 6],
    ["triangle", 2],
    ["saw", 1],
    ["sine", 1],
    ["wave", 1],
  ]);
  applyWave(ctx, wave, { table: "triangle" });
  sfx.frequency.start = noteHz(ctx, 76, 88);
  const total = between(rng, 0.12, 0.26);
  const sustain = between(rng, 0.02, 0.06);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.3, 0.5));
  slideBy(ctx, between(rng, 0.4, 1), total, -0.2);
  sfx.duty.start = drawDuty(ctx);
  pwm(ctx, 0.3, 0.4, 1.2);
  sfx.volume = round(between(rng, 0.55, 0.75), 2);
}

function fmTwoStep(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  applyWave(ctx, "fm", { fm: pick(rng, ["pluck", "bell", "glass"]) });
  sfx.frequency.start = noteHz(ctx, 76, 88);
  const step = logBetween(rng, 0.06, 0.14);
  const total = step * between(rng, 2.4, 2.9);
  const sustain = step * between(rng, 1, 1.5);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.2, 0.45));
  arpeggio(ctx, [pick(rng, [5, 7, 12, 4])], step);
  sfx.volume = round(between(rng, 0.55, 0.75), 2);
}

const FLAVORS: readonly Flavor[] = [
  { build: twoStep, weights: w(60, 65, 50, 30, 25, 30, 30) },
  { build: bell, weights: w(15, 0, 15, 45, 45, 50, 30) },
  { build: chirp, weights: w(25, 20, 30, 20, 15, 20, 20) },
  { build: fmTwoStep, weights: w(0, 0, 0, 25, 30, 0, 20) },
];

export function buildCoin(ctx: Ctx): void {
  runFlavors(ctx, FLAVORS);
}
