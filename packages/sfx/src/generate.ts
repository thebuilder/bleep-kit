/* generateSfx and randomizeSfx: one builder per category, run on a seeded stream. */
import {
  type ChipId,
  deriveSeed,
  mulberry32,
  normalizeSfx,
  type Sfx,
  type SfxCategory,
} from "@bleepkit/core";
import { blank, type Ctx, finalize, makeCtx } from "./build.ts";
import { buildAlarm } from "./categories/alarm.ts";
import { buildBlip } from "./categories/blip.ts";
import { buildCoin } from "./categories/coin.ts";
import { buildCustom } from "./categories/custom.ts";
import { buildDoor } from "./categories/door.ts";
import { buildExplosion } from "./categories/explosion.ts";
import { buildHit } from "./categories/hit.ts";
import { buildJump } from "./categories/jump.ts";
import { buildLaser } from "./categories/laser.ts";
import { buildPowerup } from "./categories/powerup.ts";
import { buildStep } from "./categories/step.ts";
import { buildTeleport } from "./categories/teleport.ts";
import { buildZap } from "./categories/zap.ts";

const BUILDERS: Readonly<Record<SfxCategory, (ctx: Ctx) => void>> = {
  alarm: buildAlarm,
  blip: buildBlip,
  coin: buildCoin,
  custom: buildCustom,
  door: buildDoor,
  explosion: buildExplosion,
  hit: buildHit,
  jump: buildJump,
  laser: buildLaser,
  powerup: buildPowerup,
  step: buildStep,
  teleport: buildTeleport,
  zap: buildZap,
};

function defaultName(category: SfxCategory, seed: number): string {
  return `${category.charAt(0).toUpperCase()}${category.slice(1)} ${seed}`;
}

/** A new sound of a category for a chip (default "nes"). The same seed always gives the same document. */
export function generateSfx(
  category: SfxCategory,
  opts: { seed: number; chip?: ChipId; name?: string }
): Sfx {
  const chip = opts.chip ?? "nes";
  const seed = Math.trunc(opts.seed);
  const rng = mulberry32(deriveSeed(seed, category));
  const name = opts.name ?? defaultName(category, seed);
  const ctx = makeCtx(rng, chip, blank(category, chip, seed, name));
  BUILDERS[category](ctx);
  return normalizeSfx(finalize(ctx)).value;
}

/** New values within the sfx's category ranges, same chip and name. */
export function randomizeSfx(sfx: Sfx, seed: number): Sfx {
  return generateSfx(sfx.category, { chip: sfx.chip, name: sfx.name, seed });
}
