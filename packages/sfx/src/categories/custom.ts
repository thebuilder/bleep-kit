/* Custom: the sfxr "randomize" button, kept safe. Any wave the chip has, a pitch path, and each effect (vibrato,
   arpeggio, PWM, filter, phaser, bitcrush) switched on with some probability. Tuned so most results are usable
   sounds rather than silence or hiss: no pitch floor cut, no filter that closes below the sound's pitch. */
import {
  applyWave,
  type Ctx,
  chooseWave,
  drawDuty,
  type FmKind,
  setEnvelope,
  type TableKind,
} from "../build.ts";
import {
  between,
  chance,
  intBetween,
  logBetween,
  pick,
  round,
} from "../util.ts";
import {
  arpeggio,
  freeHz,
  highpass,
  lowpass,
  noteHz,
  phaser,
  pwm,
  sign,
  slideBy,
  vibrato,
} from "./flavors.ts";

const FM_KINDS: readonly FmKind[] = [
  "bell",
  "pluck",
  "metal",
  "zap",
  "bass",
  "glass",
  "growl",
];
const TABLE_KINDS: readonly TableKind[] = [
  "sine",
  "triangle",
  "saw",
  "pulse",
  "organ",
  "buzz",
];
const ARP_STEPS = [-12, -7, -5, -3, 3, 4, 5, 7, 9, 12, 16, 19] as const;

function drawEnvelope(ctx: Ctx, total: number): void {
  const { rng } = ctx;
  const attack = chance(rng, 0.3)
    ? between(rng, 0, Math.min(0.1, total * 0.2))
    : 0;
  const sustain = (total - attack) * between(rng, 0.1, 0.5);
  const punch = chance(rng, 0.5) ? between(rng, 0.1, 0.7) : 0;
  setEnvelope(ctx, attack, sustain, total - attack - sustain, punch);
}

function drawPitch(ctx: Ctx, total: number): void {
  const { rng, sfx } = ctx;
  sfx.frequency.start =
    sfx.wave === "noise" ? freeHz(ctx, 100, 3000) : noteHz(ctx, 36, 96);
  if (chance(rng, 0.7)) {
    slideBy(
      ctx,
      sign(ctx, 0.45) * between(rng, 0.3, 3),
      total,
      between(rng, -0.4, 0.4)
    );
  }
}

function drawModulation(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  if (chance(rng, 0.3)) {
    vibrato(ctx, 0.1, 1.2, 4, 30);
  }
  if (chance(rng, 0.3)) {
    const count = intBetween(rng, 1, 3);
    const steps: number[] = [];
    for (let i = 0; i < count; i += 1) {
      steps.push(pick(rng, ARP_STEPS));
    }
    arpeggio(ctx, steps, logBetween(rng, 0.03, 0.2));
  }
  sfx.duty.start = drawDuty(ctx, 0.1, 0.9);
  pwm(ctx, 0.4, 0.5, 2);
}

function drawEffects(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  if (chance(rng, 0.4)) {
    lowpass(ctx, 1500, 12_000, -1.5, 0.5, [0, 0.6]);
  }
  if (chance(rng, 0.25)) {
    highpass(ctx, 80, 800, 0, 1);
  }
  if (chance(rng, 0.3)) {
    phaser(ctx, 1, 12, 25);
  }
  if (ctx.caps.bitcrush && chance(rng, 0.2)) {
    sfx.bitcrush = {
      bits: intBetween(rng, 4, 10),
      rateDivide: intBetween(rng, 1, 6),
    };
  }
}

export function buildCustom(ctx: Ctx): void {
  const { rng, sfx } = ctx;
  const wave = chooseWave(ctx, [
    ["square", 5],
    ["saw", 3],
    ["triangle", 2],
    ["sine", 2],
    ["noise", 2],
    ["wave", 1.5],
    ["fm", 3],
  ]);
  applyWave(ctx, wave, {
    fm: pick(rng, FM_KINDS),
    table: pick(rng, TABLE_KINDS),
  });
  sfx.noise.mode = chance(rng, 0.4) ? "short" : "long";
  const total = logBetween(rng, 0.12, 1.3);
  drawEnvelope(ctx, total);
  drawPitch(ctx, total);
  drawModulation(ctx);
  drawEffects(ctx);
  sfx.volume = round(between(rng, 0.55, 0.8), 2);
}
