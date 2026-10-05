/* Door: three kinds. A creak (low thin pulse or saw with a fast wobble and a slow glide), a sci-fi sliding whoosh
   (rising noise that swells in), and a slam (a low noise or triangle thunk). */
import {
  applyWave,
  type Ctx,
  chooseWave,
  drawDuty,
  setEnvelope,
} from "../build.ts";
import { between, chance, round } from "../util.ts";
import {
  type Flavor,
  freeHz,
  lowpass,
  noteHz,
  phaser,
  pwm,
  runFlavors,
  sign,
  slideBy,
  vibrato,
  w,
} from "./flavors.ts";

function creak(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["square", 6],
    ["saw", 4],
    ["triangle", 2],
    ["fm", 6],
    ["wave", 2],
  ]);
  applyWave(ctx, wave, { fm: "bass", table: "pulse" });
  sfx.frequency.start = noteHz(ctx, 34, 60);
  const total = between(rng, 0.5, 1.3);
  const attack = between(rng, 0.03, 0.12);
  const sustain = total * between(rng, 0.45, 0.6);
  setEnvelope(ctx, attack, sustain, total - attack - sustain, 0);
  slideBy(ctx, sign(ctx, 0.4) * between(rng, 0.15, 0.7), total, 0);
  vibrato(ctx, 0.3, 1.1, 14, 34);
  sfx.duty.start = drawDuty(ctx, 0.1, 0.35);
  pwm(ctx, 0.6, 0.5, 2);
  lowpass(ctx, 400, 1200, -0.8, 0.8, [0.4, 0.7]);
  sfx.volume = round(between(rng, 0.55, 0.72), 2);
}

function whoosh(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  applyWave(ctx, "noise");
  sfx.noise.mode = chance(rng, 0.25) ? "short" : "long";
  sfx.frequency.start = freeHz(ctx, 300, 1000);
  const total = between(rng, 0.5, 1);
  const attack = between(rng, 0.12, 0.3);
  const sustain = between(rng, 0.1, 0.25);
  setEnvelope(ctx, attack, sustain, total - attack - sustain, 0);
  slideBy(ctx, between(rng, 0.6, 1.6), total, 0);
  lowpass(ctx, 300, 700, 1.5, 3, [0.3, 0.6]);
  phaser(ctx, 3, 10, 15);
  sfx.volume = round(between(rng, 0.6, 0.78), 2);
}

function slam(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["noise", 5],
    ["triangle", 4],
    ["sine", 3],
    ["wave", 3],
    ["fm", 4],
    ["square", 1],
  ]);
  applyWave(ctx, wave, { fm: "bass", table: "sine" });
  sfx.noise.mode = "long";
  sfx.frequency.start =
    wave === "noise" ? freeHz(ctx, 100, 400) : freeHz(ctx, 60, 180);
  const total = between(rng, 0.15, 0.4);
  const sustain = between(rng, 0, 0.04);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.6, 0.9));
  slideBy(ctx, -between(rng, 0.5, 1.8), total, 0.2);
  lowpass(ctx, 800, 2500, -3, -1, [0.1, 0.4]);
  sfx.duty.start = drawDuty(ctx, 0.3, 0.5);
  sfx.volume = round(between(rng, 0.65, 0.82), 2);
}

const FLAVORS: readonly Flavor[] = [
  { build: creak, weights: w(45, 45, 40, 40, 70, 40, 40) },
  { build: whoosh, weights: w(30, 30, 35, 30, 0, 35, 30) },
  { build: slam, weights: w(25, 25, 25, 30, 30, 25, 25) },
];

export function buildDoor(ctx: Ctx): void {
  runFlavors(ctx, FLAVORS);
}
