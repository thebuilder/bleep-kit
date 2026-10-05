/* What each chip can say, for the generators. Mirrors section 2.4 (waves) and section 3.3 (duty, pitch range) of the
   architecture; the filter, phaser and bitcrush flags are a taste rule: an NES has no filter, so its sfx never ask for
   one. */
import type { ChipId, SfxWave } from "@bleepkit/core";

export interface ChipCaps {
  /** Authentic to use bitcrush. */
  bitcrush: boolean;
  /** Pulse duties the chip offers, or null for any. */
  duties: readonly number[] | null;
  /** Authentic to use the lowpass and highpass fields. */
  filter: boolean;
  /** Lowest Hz the chip's pitch register can reach, per wave. */
  floor: Partial<Record<SfxWave, number>>;
  /**
   * The noise rate can glide. False where a slide would turn the noise into a tone or a click train, so generators skip
   * noise slides there. The Genesis PSG has only three fixed rates, but its tone 3 mode (noise clocked by the third
   * square's period) sweeps smoothly, which the core uses whenever the pitch of a Genesis noise sfx moves.
   */
  noiseSweep: boolean;
  /** Authentic to use the phaser comb (an echo-like shimmer on the 16-bit profile). */
  phaser: boolean;
  waves: readonly SfxWave[];
}

const NES_DUTIES = [0.125, 0.25, 0.5] as const;

export const CHIP_CAPS: Readonly<Record<ChipId, ChipCaps>> = {
  adlib: {
    bitcrush: false,
    duties: null,
    filter: false,
    floor: {},
    noiseSweep: true,
    phaser: false,
    waves: ["fm", "square", "sine", "saw"],
  },
  c64: {
    bitcrush: false,
    duties: null,
    filter: true,
    floor: {},
    noiseSweep: true,
    phaser: false,
    waves: ["square", "saw", "triangle", "noise"],
  },
  custom: {
    bitcrush: true,
    duties: null,
    filter: true,
    floor: {},
    noiseSweep: true,
    phaser: true,
    waves: ["square", "triangle", "saw", "sine", "noise", "wave", "fm"],
  },
  gameboy: {
    bitcrush: false,
    duties: NES_DUTIES,
    filter: false,
    floor: { square: 66, wave: 33 },
    noiseSweep: true,
    phaser: false,
    waves: ["square", "wave", "noise"],
  },
  genesis: {
    bitcrush: false,
    duties: [0.5],
    filter: false,
    floor: { square: 110 },
    noiseSweep: true,
    phaser: false,
    waves: ["square", "noise", "fm"],
  },
  nes: {
    bitcrush: false,
    duties: NES_DUTIES,
    filter: false,
    floor: { square: 56, triangle: 28 },
    noiseSweep: true,
    phaser: false,
    waves: ["square", "triangle", "noise"],
  },
  snes: {
    bitcrush: false,
    duties: null,
    filter: true,
    floor: {},
    noiseSweep: true,
    phaser: true,
    waves: ["sine", "triangle", "saw", "square", "noise"],
  },
};

/** Highest pitch the generators start or sweep to. */
export const CEILING_HZ = 7000;
/** Lowest pitch anything is generated at, whatever the chip. */
const FLOOR_HZ = 24;

export function floorHz(chip: ChipId, wave: SfxWave): number {
  return Math.max(FLOOR_HZ, CHIP_CAPS[chip].floor[wave] ?? FLOOR_HZ);
}

/** The duty the chip would play for a requested one: nearest of its list, or the value itself. */
export function snapDuty(chip: ChipId, duty: number): number {
  const list = CHIP_CAPS[chip].duties;
  if (!list) {
    return duty;
  }
  let best = list[0] ?? 0.5;
  for (const d of list) {
    if (Math.abs(d - duty) < Math.abs(best - duty)) {
      best = d;
    }
  }
  return best;
}
