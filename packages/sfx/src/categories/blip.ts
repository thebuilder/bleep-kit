/* Blip: a tiny UI beep. A select beep, a two-tone confirm, a falling cancel, a noise tick (typewriter) and an FM
   ping. Fixed musical pitches, 25 to 150 ms. */
import {
  applyWave,
  type Ctx,
  chooseWave,
  drawDuty,
  setEnvelope,
} from "../build.ts";
import { between, logBetween, pick, round } from "../util.ts";
import {
  arpeggio,
  type Flavor,
  freeHz,
  noteHz,
  runFlavors,
  slideBy,
  w,
} from "./flavors.ts";

function select(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["square", 6],
    ["triangle", 3],
    ["sine", 2],
    ["wave", 2],
    ["saw", 1],
  ]);
  applyWave(ctx, wave, { table: pick(rng, ["sine", "triangle"]) });
  sfx.frequency.start = noteHz(ctx, 69, 100);
  const total = between(rng, 0.03, 0.1);
  const sustain = between(rng, 0.01, 0.04);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.2, 0.4));
  sfx.duty.start = drawDuty(ctx, 0.2, 0.5);
  sfx.volume = round(between(rng, 0.5, 0.7), 2);
}

function twoTone(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["square", 6],
    ["triangle", 3],
    ["sine", 2],
    ["wave", 2],
  ]);
  applyWave(ctx, wave, { table: "triangle" });
  sfx.frequency.start = noteHz(ctx, 69, 91);
  const step = logBetween(rng, 0.03, 0.06);
  const total = step * between(rng, 2.2, 2.8);
  const sustain = step * between(rng, 1.1, 1.6);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.15, 0.35));
  arpeggio(ctx, [pick(rng, [5, 7, 12, -5, -7, 4])], step);
  sfx.duty.start = drawDuty(ctx, 0.2, 0.5);
  sfx.volume = round(between(rng, 0.5, 0.7), 2);
}

function cancel(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["square", 6],
    ["triangle", 3],
    ["saw", 1],
    ["wave", 2],
    ["sine", 1],
  ]);
  applyWave(ctx, wave, { table: "triangle" });
  sfx.frequency.start = noteHz(ctx, 64, 84);
  const total = between(rng, 0.06, 0.14);
  const sustain = between(rng, 0.01, 0.05);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.1, 0.3));
  slideBy(ctx, -between(rng, 0.5, 1.3), total, 0);
  sfx.duty.start = drawDuty(ctx, 0.2, 0.5);
  sfx.volume = round(between(rng, 0.5, 0.7), 2);
}

function tick(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  applyWave(ctx, "noise");
  sfx.noise.mode = rng() < 0.5 ? "short" : "long";
  sfx.frequency.start = freeHz(ctx, 2000, 6000);
  const total = between(rng, 0.02, 0.05);
  setEnvelope(ctx, 0, 0, total, between(rng, 0.2, 0.5));
  sfx.volume = round(between(rng, 0.55, 0.75), 2);
}

function ping(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  applyWave(ctx, "fm", { fm: pick(rng, ["glass", "pluck", "bell"]) });
  sfx.frequency.start = noteHz(ctx, 69, 93);
  const total = between(rng, 0.05, 0.14);
  const sustain = between(rng, 0, 0.03);
  setEnvelope(ctx, 0, sustain, total - sustain, between(rng, 0.2, 0.4));
  sfx.volume = round(between(rng, 0.5, 0.7), 2);
}

const FLAVORS: readonly Flavor[] = [
  { build: select, weights: w(45, 45, 45, 35, 40, 45, 40) },
  { build: twoTone, weights: w(25, 25, 25, 20, 25, 25, 25) },
  { build: cancel, weights: w(15, 15, 15, 15, 15, 15, 15) },
  { build: tick, weights: w(8, 8, 8, 8, 0, 8, 8) },
  { build: ping, weights: w(0, 0, 0, 30, 40, 0, 20) },
];

export function buildBlip(ctx: Ctx): void {
  runFlavors(ctx, FLAVORS);
}
