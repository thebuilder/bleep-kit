/* Hit: impact. A noise thwack with a fast pitch fall, a low tonal thud, a bright slap, and an FM knock. Short and
   punchy: the envelope punch does the work. */
import {
  applyWave,
  type Ctx,
  chooseWave,
  drawDuty,
  setEnvelope,
} from "../build.ts";
import { between, pick, round } from "../util.ts";
import {
  type Flavor,
  freeHz,
  lowpass,
  noiseHz,
  runFlavors,
  setNoiseMode,
  slideBy,
  w,
} from "./flavors.ts";

function thwack(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  applyWave(ctx, "noise");
  setNoiseMode(ctx, 0.5);
  sfx.frequency.start = noiseHz(ctx, [300, 2400], [150, 900]);
  const total = between(rng, 0.06, 0.2);
  const sustain = between(rng, 0, 0.04);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.4, 0.9));
  slideBy(ctx, -between(rng, 0.8, 2.2), total, 0.2);
  lowpass(ctx, 1500, 5000, -5, -2, [0.1, 0.4]);
  sfx.volume = round(between(rng, 0.6, 0.8), 2);
}

function thud(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["triangle", 4],
    ["sine", 3],
    ["square", 3],
    ["wave", 3],
    ["saw", 1],
  ]);
  applyWave(ctx, wave, { table: pick(rng, ["sine", "triangle"]) });
  sfx.frequency.start = freeHz(ctx, 120, 420);
  const total = between(rng, 0.1, 0.25);
  const sustain = between(rng, 0, 0.05);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.5, 0.8));
  slideBy(ctx, -between(rng, 1, 2), total, 0.2);
  sfx.duty.start = drawDuty(ctx, 0.3, 0.5);
  sfx.volume = round(between(rng, 0.65, 0.8), 2);
}

function slap(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["square", 6],
    ["saw", 2],
    ["wave", 2],
    ["triangle", 1],
  ]);
  applyWave(ctx, wave, { table: "pulse" });
  sfx.frequency.start = freeHz(ctx, 600, 1800);
  const total = between(rng, 0.06, 0.14);
  const sustain = between(rng, 0, 0.03);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.3, 0.7));
  slideBy(ctx, -between(rng, 1, 1.8), total, 0.3);
  sfx.duty.start = drawDuty(ctx, 0.1, 0.3);
  sfx.volume = round(between(rng, 0.6, 0.78), 2);
}

function fmKnock(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  applyWave(ctx, "fm", { fm: pick(rng, ["bass", "zap", "pluck"]) });
  sfx.frequency.start = freeHz(ctx, 100, 320);
  const total = between(rng, 0.08, 0.22);
  const sustain = between(rng, 0, 0.04);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.4, 0.8));
  slideBy(ctx, -between(rng, 0.8, 1.8), total, 0.2);
  sfx.volume = round(between(rng, 0.62, 0.8), 2);
}

const FLAVORS: readonly Flavor[] = [
  { build: thwack, weights: w(45, 45, 40, 40, 0, 45, 35) },
  { build: thud, weights: w(35, 25, 30, 25, 40, 30, 25) },
  { build: slap, weights: w(20, 30, 20, 15, 20, 20, 20) },
  { build: fmKnock, weights: w(0, 0, 0, 30, 40, 0, 20) },
];

export function buildHit(ctx: Ctx): void {
  runFlavors(ctx, FLAVORS);
}
