/* Teleport: a sweep with a shimmer. Warp-up (rising, wobbling, sparkling), warp-down (the reverse), a shimmer (a
   fast high arpeggio, phaser on the 16-bit profile), a noise swirl with a filter sweep, and an FM sweep whose
   timbre closes as it rises. */
import {
  applyWave,
  type Ctx,
  chooseWave,
  drawDuty,
  setEnvelope,
} from "../build.ts";
import { between, chance, pick, round } from "../util.ts";
import {
  arpeggio,
  type Flavor,
  freeHz,
  highpass,
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

function warp(ctx: Ctx, up: boolean): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["saw", 4],
    ["square", 5],
    ["triangle", 2],
    ["sine", 2],
    ["wave", 2],
  ]);
  applyWave(ctx, wave, { table: pick(rng, ["saw", "organ"]) });
  sfx.frequency.start = up ? noteHz(ctx, 45, 65) : noteHz(ctx, 72, 92);
  const total = between(rng, 0.6, 1.3);
  const attack = between(rng, 0.05, 0.2);
  const sustain = total * between(rng, 0.25, 0.4);
  setEnvelope(
    ctx,
    attack,
    sustain,
    total - attack - sustain,
    between(rng, 0, 0.2)
  );
  const octaves = between(rng, 2, 4.2) * (up ? 1 : -1);
  slideBy(ctx, octaves, total, between(rng, 0.1, 0.4));
  vibrato(ctx, 0.4, 1.2, 10, 22);
  if (chance(rng, 0.3)) {
    arpeggio(ctx, [12], 1 / between(rng, 25, 40));
  }
  sfx.duty.start = drawDuty(ctx, 0.2, 0.5);
  pwm(ctx, 0.4, 0.5, 2);
  lowpass(ctx, 500, 1500, up ? 1 : -1, up ? 3 : -0.5, [0.4, 0.7]);
  phaser(ctx, 3, 10, 25);
  sfx.volume = round(between(rng, 0.55, 0.72), 2);
}

function warpUp(ctx: Ctx): void {
  warp(ctx, true);
}

function warpDown(ctx: Ctx): void {
  warp(ctx, false);
}

function shimmer(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["sine", 4],
    ["triangle", 4],
    ["fm", 5],
    ["square", 2],
    ["wave", 3],
  ]);
  applyWave(ctx, wave, { fm: "glass", table: "sine" });
  sfx.frequency.start = noteHz(ctx, 60, 84);
  const total = between(rng, 0.5, 1.2);
  const attack = between(rng, 0, 0.1);
  const sustain = total * between(rng, 0.3, 0.5);
  setEnvelope(
    ctx,
    attack,
    sustain,
    total - attack - sustain,
    between(rng, 0, 0.2)
  );
  arpeggio(
    ctx,
    pick(rng, [
      [4, 7, 12],
      [7, 12, 19],
      [5, 12, 17],
      [3, 7, 10],
    ]),
    1 / between(rng, 24, 48)
  );
  slideBy(ctx, sign(ctx, 0.6) * between(rng, 0.5, 1.5), total, 0);
  vibrato(ctx, 0.1, 0.4, 5, 10);
  phaser(ctx, 4, 12, 30);
  sfx.duty.start = drawDuty(ctx, 0.3, 0.5);
  sfx.volume = round(between(rng, 0.5, 0.7), 2);
}

function swirl(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  applyWave(ctx, "noise");
  sfx.noise.mode = chance(rng, 0.4) ? "short" : "long";
  sfx.frequency.start = freeHz(ctx, 300, 2000);
  const total = between(rng, 0.5, 1.2);
  const attack = between(rng, 0.1, 0.3);
  const sustain = total * between(rng, 0.2, 0.35);
  setEnvelope(ctx, attack, sustain, total - attack - sustain, 0);
  slideBy(ctx, sign(ctx, 0.5) * between(rng, 1, 2.5), total, 0);
  vibrato(ctx, 0.5, 1.8, 6, 16);
  lowpass(ctx, 400, 1500, 1, 3, [0.4, 0.8]);
  highpass(ctx, 200, 800);
  phaser(ctx, 3, 12, 25);
  sfx.volume = round(between(rng, 0.6, 0.78), 2);
}

function fmWarp(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  applyWave(ctx, "fm", { fm: pick(rng, ["metal", "zap", "bell"]) });
  sfx.frequency.start = noteHz(ctx, 43, 67);
  const total = between(rng, 0.6, 1.4);
  const attack = between(rng, 0.03, 0.15);
  const sustain = total * between(rng, 0.25, 0.4);
  setEnvelope(
    ctx,
    attack,
    sustain,
    total - attack - sustain,
    between(rng, 0, 0.2)
  );
  slideBy(
    ctx,
    sign(ctx, 0.75) * between(rng, 2, 3.5),
    total,
    between(rng, 0.1, 0.35)
  );
  vibrato(ctx, 0.4, 1.2, 8, 20);
  if (sfx.fm) {
    sfx.fm.indexDecay = round(between(rng, 0.5, 1.5), 2);
  }
  sfx.volume = round(between(rng, 0.55, 0.72), 2);
}

const FLAVORS: readonly Flavor[] = [
  { build: warpUp, weights: w(40, 40, 35, 25, 25, 30, 30) },
  { build: warpDown, weights: w(20, 20, 25, 20, 20, 25, 20) },
  { build: shimmer, weights: w(25, 15, 25, 25, 35, 40, 30) },
  { build: swirl, weights: w(25, 25, 30, 25, 0, 30, 25) },
  { build: fmWarp, weights: w(0, 0, 0, 35, 45, 0, 25) },
];

export function buildTeleport(ctx: Ctx): void {
  runFlavors(ctx, FLAVORS);
}
