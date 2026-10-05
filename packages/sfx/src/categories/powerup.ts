/* Powerup: something rising. A major-ish arpeggio that also lifts in pitch (the classic mushroom), a long glide up
   with a wobble, a high chime run (1-up), and an FM version. */
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
  lowpass,
  noteHz,
  phaser,
  pwm,
  runFlavors,
  slideBy,
  vibrato,
  w,
} from "./flavors.ts";

const ARP_PATTERNS: readonly number[][] = [
  [4, 7, 12],
  [3, 7, 12],
  [4, 7, 11],
  [5, 9, 12],
  [7, 12, 16],
  [2, 4, 7, 9],
  [4, 7, 12, 16],
  [2, 5, 9, 12],
];

function arpUp(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["square", 6],
    ["triangle", 3],
    ["wave", 2],
    ["saw", 1],
    ["sine", 1],
  ]);
  applyWave(ctx, wave, { table: pick(rng, ["triangle", "organ"]) });
  sfx.frequency.start = noteHz(ctx, 55, 72);
  const total = between(rng, 0.35, 0.8);
  const sustain = total * between(rng, 0.5, 0.65);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.1, 0.25));
  arpeggio(ctx, pick(rng, ARP_PATTERNS), 1 / between(rng, 12, 24));
  slideBy(ctx, between(rng, 0.3, 1), total, 0.2);
  sfx.duty.start = drawDuty(ctx, 0.2, 0.5);
  pwm(ctx, 0.3, 0.5, 1.5);
  phaser(ctx, 2, 6, 10);
  sfx.volume = round(between(rng, 0.55, 0.72), 2);
}

function glide(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["square", 5],
    ["saw", 4],
    ["triangle", 2],
    ["wave", 1],
  ]);
  applyWave(ctx, wave, { table: "saw" });
  sfx.frequency.start = noteHz(ctx, 48, 65);
  const total = between(rng, 0.35, 0.7);
  const attack = between(rng, 0.01, 0.05);
  const sustain = total * between(rng, 0.3, 0.45);
  setEnvelope(
    ctx,
    attack,
    sustain,
    total - attack - sustain,
    between(rng, 0.05, 0.2)
  );
  slideBy(ctx, between(rng, 1.5, 3.2), total, between(rng, 0.1, 0.4));
  if (chance(rng, 0.4)) {
    vibrato(ctx, 0.2, 0.5, 8, 14);
  }
  sfx.duty.start = drawDuty(ctx, 0.2, 0.5);
  lowpass(ctx, 600, 1800, 1, 3, [0.2, 0.5]);
  phaser(ctx, 2, 6, 10);
  sfx.volume = round(between(rng, 0.55, 0.72), 2);
}

function chime(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["fm", 5],
    ["sine", 3],
    ["triangle", 3],
    ["wave", 3],
  ]);
  applyWave(ctx, wave, { fm: pick(rng, ["bell", "glass"]), table: "sine" });
  sfx.frequency.start = noteHz(ctx, 72, 84);
  const total = between(rng, 0.5, 0.9);
  const sustain = between(rng, 0.1, 0.25);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.1, 0.3));
  arpeggio(
    ctx,
    pick(rng, [
      [5, 9, 12],
      [4, 7, 12],
      [7, 12, 16],
      [4, 9, 12],
    ]),
    1 / between(rng, 14, 20)
  );
  phaser(ctx, 3, 9, 15);
  sfx.volume = round(between(rng, 0.55, 0.72), 2);
}

function fmUp(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  applyWave(ctx, "fm", { fm: pick(rng, ["pluck", "bell"]) });
  sfx.frequency.start = noteHz(ctx, 55, 72);
  const total = between(rng, 0.35, 0.8);
  const sustain = total * between(rng, 0.45, 0.6);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.1, 0.25));
  arpeggio(ctx, pick(rng, ARP_PATTERNS), 1 / between(rng, 12, 22));
  slideBy(ctx, between(rng, 0.3, 1), total, 0.2);
  sfx.volume = round(between(rng, 0.55, 0.72), 2);
}

const FLAVORS: readonly Flavor[] = [
  { build: arpUp, weights: w(55, 55, 50, 35, 40, 45, 40) },
  { build: glide, weights: w(25, 25, 30, 20, 20, 25, 25) },
  { build: chime, weights: w(10, 15, 10, 25, 30, 30, 25) },
  { build: fmUp, weights: w(0, 0, 0, 30, 40, 0, 20) },
];

export function buildPowerup(ctx: Ctx): void {
  runFlavors(ctx, FLAVORS);
}
