/* Zap: electricity. Where a laser is one clean dive, a zap is jittery: fast vibrato and a quick arpeggio make the
   pitch crackle, noise bursts spit, FM chips use a harsh high-index patch. */
import {
  applyWave,
  type Ctx,
  chooseWave,
  drawDuty,
  setEnvelope,
} from "../build.ts";
import { between, intBetween, pick, round } from "../util.ts";
import {
  arpeggio,
  type Flavor,
  freeHz,
  highpass,
  noteHz,
  runFlavors,
  setNoiseMode,
  sign,
  slideBy,
  vibrato,
  w,
} from "./flavors.ts";

const JITTER_STEPS = [12, -12, 7, -5, 5, -7, 3, 10, -3, 9] as const;

function jitterSteps(ctx: Ctx, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(pick(ctx.rng, JITTER_STEPS));
  }
  return out;
}

function buzz(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["saw", 5],
    ["square", 5],
    ["triangle", 1],
    ["wave", 1],
  ]);
  applyWave(ctx, wave, { table: "buzz" });
  sfx.frequency.start = noteHz(ctx, 60, 84);
  const total = between(rng, 0.1, 0.35);
  const sustain = between(rng, 0.03, 0.12);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.3, 0.6));
  slideBy(ctx, sign(ctx, 0.4) * between(rng, 0.4, 2), total, 0.2);
  vibrato(ctx, 0.8, 2, 22, 40);
  arpeggio(
    ctx,
    jitterSteps(ctx, intBetween(rng, 2, 3)),
    1 / between(rng, 28, 55)
  );
  sfx.duty.start = drawDuty(ctx, 0.1, 0.5);
  highpass(ctx, 500, 2500);
  sfx.volume = round(between(rng, 0.5, 0.7), 2);
}

function crackle(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  applyWave(ctx, "noise");
  setNoiseMode(ctx, 0.6);
  sfx.frequency.start = freeHz(ctx, 1500, 6000);
  const total = between(rng, 0.08, 0.3);
  const sustain = between(rng, 0.01, 0.08);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.4, 0.7));
  slideBy(ctx, sign(ctx, 0.3) * between(rng, 0.5, 1.8), total, 0.2);
  vibrato(ctx, 0.5, 1.5, 20, 38);
  highpass(ctx, 600, 3000);
  sfx.volume = round(between(rng, 0.5, 0.7), 2);
}

function fmZap(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  applyWave(ctx, "fm", { fm: "zap" });
  sfx.frequency.start = noteHz(ctx, 50, 79);
  const total = between(rng, 0.12, 0.4);
  const sustain = between(rng, 0.02, 0.1);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.3, 0.6));
  slideBy(ctx, sign(ctx, 0.4) * between(rng, 0.3, 1.6), total, 0.2);
  vibrato(ctx, 0.5, 1.5, 20, 38);
  sfx.volume = round(between(rng, 0.5, 0.7), 2);
}

function spark(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["square", 6],
    ["saw", 2],
    ["triangle", 1],
  ]);
  applyWave(ctx, wave);
  sfx.frequency.start = noteHz(ctx, 48, 70);
  const total = between(rng, 0.1, 0.22);
  const sustain = between(rng, 0.03, 0.1);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.2, 0.5));
  slideBy(ctx, between(rng, 0.8, 1.6), total, 0);
  vibrato(ctx, 1, 2, 24, 40);
  sfx.duty.start = drawDuty(ctx, 0.1, 0.4);
  sfx.volume = round(between(rng, 0.5, 0.7), 2);
}

const FLAVORS: readonly Flavor[] = [
  { build: buzz, weights: w(50, 50, 45, 25, 35, 35, 35) },
  { build: crackle, weights: w(35, 35, 30, 30, 0, 30, 25) },
  { build: fmZap, weights: w(0, 0, 0, 40, 40, 0, 20) },
  { build: spark, weights: w(15, 15, 15, 15, 15, 15, 15) },
];

export function buildZap(ctx: Ctx): void {
  runFlavors(ctx, FLAVORS);
}
