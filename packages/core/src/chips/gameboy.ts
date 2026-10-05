/* Game Boy (DMG APU): two pulse channels, a 32 x 4-bit wave channel, noise. Hard left/right panning. */

import type { ChipProfile } from "../types.ts";

const GB_CLOCK_HZ = 4_194_304;

export const GAMEBOY: ChipProfile = {
  channels: [
    { id: "pulse1", kind: "pulse", label: "Pulse 1" },
    { id: "pulse2", kind: "pulse", label: "Pulse 2" },
    { id: "wave", kind: "wave", label: "Wave" },
    { id: "noise", kind: "noise", label: "Noise" },
  ],
  color: {
    bits: null,
    dac: "linear",
    gaussian: false,
    highpassHz: 60,
    lowpassHz: 12_000,
    sampleRate: null,
  },
  constraints: {
    clockHz: GB_CLOCK_HZ,
    dutyCycles: [0.125, 0.25, 0.5, 0.75],
    filter: false,
    masterFx: false,
    noise: "lfsr7-15",
    pan: "hard",
    pitch: "period",
    triangleSteps: 0,
    volumeSteps: 16,
    waveTable: { bits: 4, length: 32 },
  },
  fmWaveforms: false,
  id: "gameboy",
  kinds: ["pulse", "wave", "noise"],
  label: "Game Boy (DMG)",
  sampleRate: null,
};

const REGISTER_MAX = 2047;

/** Frequency register: pulse f = 131072 / (2048 - x), wave f = 65536 / (2048 - x). */
function hzToPeriod(hz: number, kind: "pulse" | "wave" = "pulse"): number {
  const base = kind === "pulse" ? 131_072 : 65_536;
  const x = 2048 - Math.round(base / Math.max(hz, 1));
  return Math.min(REGISTER_MAX, Math.max(0, x));
}

function periodToHz(period: number, kind: "pulse" | "wave" = "pulse"): number {
  const base = kind === "pulse" ? 131_072 : 65_536;
  return base / (2048 - period);
}

export function quantizePulseHz(hz: number): number {
  return periodToHz(hzToPeriod(hz, "pulse"), "pulse");
}

export function quantizeWaveHz(hz: number): number {
  return periodToHz(hzToPeriod(hz, "wave"), "wave");
}

const DIVISORS = [0.5, 1, 2, 3, 4, 5, 6, 7] as const;

/** All LFSR clock rates the noise register can select (262144 / (r * 2^s)), ascending. */
const GB_NOISE_RATES: readonly number[] = (() => {
  const set = new Set<number>();
  for (const r of DIVISORS) {
    for (let s = 0; s <= 13; s += 1) {
      set.add(262_144 / (r * 2 ** s));
    }
  }
  return [...set].sort((a, b) => a - b);
})();

export function quantizeNoiseRate(hz: number): number {
  const want = Math.max(hz, 1) * 16;
  let best = GB_NOISE_RATES[0] ?? want;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const rate of GB_NOISE_RATES) {
    const d = Math.abs(Math.log(rate / want));
    if (d < bestDist) {
      bestDist = d;
      best = rate;
    }
  }
  return best;
}
