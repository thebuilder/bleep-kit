/* Explosion: the chip's noise channel falling in pitch, with a hard punch and a long tail. Boom is the standard rumble,
   crunch is the metallic short-mode noise (NES and Game Boy style), big is a long slow one. Chips with no noise
   (AdLib) get a deep FM growl instead. SID sweeps a lowpass down; the 16-bit profile adds a swirl of phaser. */
import { applyWave, type Ctx, chooseWave, setEnvelope } from "../build.ts";
import { between, chance, round } from "../util.ts";
import {
  type Flavor,
  freeHz,
  lowpass,
  noiseHz,
  noteHz,
  phaser,
  runFlavors,
  setNoiseMode,
  slideBy,
  vibrato,
  w,
} from "./flavors.ts";

function boom(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  applyWave(ctx, "noise");
  // The 8-bit chips only get a boom from the long register at the bottom of the rate table.
  const lowTable = ctx.chip === "nes" || ctx.chip === "gameboy";
  setNoiseMode(ctx, lowTable ? 0 : 0.3);
  sfx.frequency.start = noiseHz(ctx, [100, 700], [60, 250]);
  const total = between(rng, 0.6, 1.6);
  const attack = between(rng, 0, 0.01);
  const sustain = between(rng, 0.05, 0.3);
  setEnvelope(
    ctx,
    attack,
    sustain,
    total - attack - sustain,
    between(rng, 0.3, 0.8)
  );
  slideBy(ctx, -between(rng, 1.2, 3), total, between(rng, -0.5, -0.2));
  lowpass(ctx, 2000, 7000, -2.5, -0.8, [0.1, 0.5]);
  if (chance(rng, 0.5)) {
    phaser(ctx, 2, 10, 20);
  }
  sfx.volume = round(between(rng, 0.65, 0.85), 2);
}

function crunch(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  applyWave(ctx, "noise");
  // The crunch is the metallic one: the 8-bit chips only play it from the short register.
  setNoiseMode(ctx, ctx.chip === "nes" || ctx.chip === "gameboy" ? 1 : 0.75);
  sfx.frequency.start = freeHz(ctx, 500, 2000);
  const total = between(rng, 0.3, 0.7);
  const sustain = between(rng, 0.03, 0.15);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.6, 0.9));
  slideBy(ctx, -between(rng, 0.5, 1.5), total, between(rng, -0.4, 0));
  lowpass(ctx, 3000, 8000, -2, -0.5, [0.1, 0.4]);
  sfx.volume = round(between(rng, 0.65, 0.85), 2);
}

function big(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  applyWave(ctx, "noise");
  sfx.noise.mode = "long";
  sfx.frequency.start = noiseHz(ctx, [60, 300], [60, 250]);
  const total = between(rng, 1.3, 2.2);
  const attack = between(rng, 0, 0.02);
  const sustain = between(rng, 0.2, 0.5);
  setEnvelope(
    ctx,
    attack,
    sustain,
    total - attack - sustain,
    between(rng, 0.2, 0.6)
  );
  slideBy(ctx, -between(rng, 0.8, 1.8), total, between(rng, -0.5, -0.2));
  lowpass(ctx, 1500, 5000, -1.5, -0.4, [0.2, 0.5]);
  phaser(ctx, 3, 12, 15);
  sfx.volume = round(between(rng, 0.7, 0.85), 2);
}

function fmBoom(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["fm", 7],
    ["saw", 2],
    ["square", 1],
  ]);
  applyWave(ctx, wave, { fm: "growl" });
  sfx.frequency.start = noteHz(ctx, 33, 47);
  const total = between(rng, 0.6, 1.4);
  const sustain = between(rng, 0.05, 0.25);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.3, 0.7));
  slideBy(ctx, -between(rng, 0.3, 1.2), total, between(rng, -0.4, 0));
  if (sfx.wave !== "fm" || chance(rng, 0.5)) {
    vibrato(ctx, 0.5, 1.8, 14, 38);
  }
  if (sfx.fm) {
    sfx.fm.indexDecay = round(between(rng, 0.4, 1), 2);
  }
  sfx.volume = round(between(rng, 0.65, 0.85), 2);
}

const FLAVORS: readonly Flavor[] = [
  { build: boom, weights: w(45, 45, 40, 40, 0, 40, 35) },
  { build: crunch, weights: w(25, 25, 20, 25, 0, 20, 20) },
  { build: big, weights: w(20, 20, 25, 15, 0, 25, 20) },
  { build: fmBoom, weights: w(0, 0, 0, 20, 100, 0, 25) },
];

export function buildExplosion(ctx: Ctx): void {
  runFlavors(ctx, FLAVORS);
}
