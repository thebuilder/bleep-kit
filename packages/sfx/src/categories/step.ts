/* Step: a footfall. A dry noise tick, a low thud (noise or a quick-falling tone), a soft scuff, and a tonal tap for
   chips with no noise. Everything is 25 to 200 ms, and the pitch spread is wide so a walk cycle of several seeds
   does not sound like a machine gun. */
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
  highpass,
  lowpass,
  noiseHz,
  runFlavors,
  setNoiseMode,
  slideBy,
  w,
} from "./flavors.ts";

function tick(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  applyWave(ctx, "noise");
  // A tick is hat-like: short noise is welcome, even on the Genesis.
  setNoiseMode(ctx, 0.5, true);
  sfx.frequency.start = noiseHz(ctx, [500, 4000], [300, 1500]);
  const total = between(rng, 0.03, 0.08);
  const sustain = between(rng, 0, 0.01);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.3, 0.6));
  slideBy(ctx, -between(rng, 0.3, 1.2), total, 0);
  lowpass(ctx, 2000, 6000, -2, -0.5, [0.1, 0.3]);
  sfx.volume = round(between(rng, 0.55, 0.75), 2);
}

function thud(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["noise", 6],
    ["triangle", 3],
    ["sine", 2],
    ["wave", 2],
  ]);
  applyWave(ctx, wave, { table: pick(rng, ["sine", "triangle"]) });
  sfx.noise.mode = "long";
  sfx.frequency.start =
    wave === "noise"
      ? noiseHz(ctx, [80, 260], [300, 1500])
      : freeHz(ctx, 60, 150);
  const total = between(rng, 0.06, 0.14);
  const sustain = between(rng, 0.005, 0.03);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.4, 0.7));
  slideBy(ctx, -between(rng, 0.5, 1.5), total, 0.2);
  lowpass(ctx, 600, 2000, -3, -1, [0.1, 0.3]);
  sfx.volume = round(between(rng, 0.65, 0.82), 2);
}

function scuff(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  applyWave(ctx, "noise");
  setNoiseMode(ctx, 0.5, true);
  sfx.frequency.start = noiseHz(ctx, [1500, 5000], [300, 1500]);
  const total = between(rng, 0.08, 0.2);
  const attack = between(rng, 0.01, 0.03);
  setEnvelope(ctx, attack, between(rng, 0, 0.02), 0, between(rng, 0, 0.3));
  sfx.envelope.decay = total - attack - sfx.envelope.sustain;
  slideBy(ctx, -between(rng, 0.3, 1), total, 0);
  highpass(ctx, 400, 1500);
  sfx.volume = round(between(rng, 0.5, 0.7), 2);
}

function tap(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["fm", 5],
    ["square", 3],
    ["saw", 2],
    ["sine", 2],
    ["triangle", 2],
  ]);
  applyWave(ctx, wave, { fm: "bass" });
  sfx.frequency.start = freeHz(ctx, 80, 220);
  const total = between(rng, 0.05, 0.12);
  const sustain = between(rng, 0, 0.02);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.3, 0.6));
  slideBy(ctx, -between(rng, 0.8, 1.8), total, 0.2);
  sfx.duty.start = drawDuty(ctx, 0.2, 0.5);
  sfx.volume = round(between(rng, 0.6, 0.78), 2);
}

const FLAVORS: readonly Flavor[] = [
  { build: tick, weights: w(40, 40, 35, 35, 0, 35, 30) },
  { build: thud, weights: w(35, 35, 30, 30, 0, 30, 30) },
  { build: scuff, weights: w(15, 15, 20, 20, 0, 20, 15) },
  { build: tap, weights: w(0, 0, 0, 0, 100, 0, 20) },
];

export function buildStep(ctx: Ctx): void {
  runFlavors(ctx, FLAVORS);
}
