/* Alarm: a held tone that keeps changing. A two-tone siren (the base note alternating with one arpeggio step), a
   rising wail that restarts every cycle (repeat), and a warble (slow deep vibrato). One to three seconds. */
import {
  applyWave,
  type Ctx,
  chooseWave,
  drawDuty,
  setEnvelope,
} from "../build.ts";
import { between, clamp, pick, round } from "../util.ts";
import {
  type Flavor,
  noteHz,
  runFlavors,
  slideBy,
  vibrato,
  w,
} from "./flavors.ts";

const SIREN_INTERVALS = [4, 5, 7, -3, -4, -5] as const;

function twoTone(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["square", 6],
    ["triangle", 3],
    ["saw", 3],
    ["sine", 2],
    ["wave", 2],
    ["fm", 4],
  ]);
  applyWave(ctx, wave, { fm: "glass", table: "pulse" });
  sfx.frequency.start = noteHz(ctx, 45, 80);
  const half = 1 / between(rng, 1.6, 5);
  const total = clamp(half * between(rng, 4, 8), 1, 2.8);
  setEnvelope(ctx, 0.01, total - 0.11, 0.1, 0);
  sfx.arpeggio = {
    rate: round(1 / half, 2),
    steps: [pick(rng, SIREN_INTERVALS)],
  };
  sfx.duty.start = drawDuty(ctx, 0.25, 0.5);
  sfx.volume = round(between(rng, 0.5, 0.68), 2);
}

function wail(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["saw", 5],
    ["square", 5],
    ["triangle", 2],
    ["fm", 4],
    ["wave", 2],
  ]);
  applyWave(ctx, wave, { fm: "glass", table: "saw" });
  sfx.frequency.start = noteHz(ctx, 52, 64);
  const cycles = between(rng, 1, 2.2);
  const total = clamp(between(rng, 3, 4.5) / cycles, 1.3, 2.6);
  setEnvelope(ctx, 0.02, total - 0.14, 0.12, 0);
  sfx.repeat.rate = round(cycles, 2);
  slideBy(ctx, between(rng, 0.6, 1) * cycles * total, total, 0);
  sfx.duty.start = drawDuty(ctx, 0.25, 0.5);
  sfx.volume = round(between(rng, 0.5, 0.68), 2);
}

function warble(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["square", 5],
    ["triangle", 3],
    ["saw", 3],
    ["sine", 3],
    ["wave", 2],
    ["fm", 4],
  ]);
  applyWave(ctx, wave, { fm: "glass", table: "pulse" });
  sfx.frequency.start = noteHz(ctx, 72, 88);
  const total = between(rng, 1, 2);
  setEnvelope(ctx, 0.01, total - 0.11, 0.1, 0);
  vibrato(ctx, 1.2, 2, 3, 7);
  sfx.duty.start = drawDuty(ctx, 0.25, 0.5);
  sfx.volume = round(between(rng, 0.5, 0.68), 2);
}

const FLAVORS: readonly Flavor[] = [
  { build: twoTone, weights: w(50, 50, 45, 40, 45, 45, 40) },
  { build: wail, weights: w(25, 25, 30, 25, 25, 25, 25) },
  { build: warble, weights: w(25, 25, 25, 25, 30, 30, 25) },
];

export function buildAlarm(ctx: Ctx): void {
  runFlavors(ctx, FLAVORS);
}
