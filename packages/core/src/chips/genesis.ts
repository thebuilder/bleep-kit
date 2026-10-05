/* Sega Genesis: YM2612 (6 x 4-operator FM) plus the SN76489 PSG (3 square channels and noise). */

import type { ChipProfile } from "../types.ts";

export const GENESIS_CLOCK_HZ = 3_579_545;
/** The FM channels attenuate in 128 steps, the PSG in 16. */
export const GENESIS_FM_VOLUME_STEPS = 128;

export const GENESIS: ChipProfile = {
  channels: [
    { fmOps: 4, id: "fm1", kind: "fm", label: "FM 1" },
    { fmOps: 4, id: "fm2", kind: "fm", label: "FM 2" },
    { fmOps: 4, id: "fm3", kind: "fm", label: "FM 3" },
    { fmOps: 4, id: "fm4", kind: "fm", label: "FM 4" },
    { fmOps: 4, id: "fm5", kind: "fm", label: "FM 5" },
    { fmOps: 4, id: "fm6", kind: "fm", label: "FM 6" },
    { fixedDuty: 0.5, id: "psg1", kind: "pulse", label: "PSG 1" },
    { fixedDuty: 0.5, id: "psg2", kind: "pulse", label: "PSG 2" },
    { fixedDuty: 0.5, id: "psg3", kind: "pulse", label: "PSG 3" },
    { id: "psgNoise", kind: "noise", label: "PSG Noise" },
  ],
  color: {
    bits: null,
    dac: "ym",
    gaussian: false,
    highpassHz: null,
    lowpassHz: 18_000,
    sampleRate: null,
  },
  constraints: {
    clockHz: GENESIS_CLOCK_HZ,
    dutyCycles: [0.5],
    filter: false,
    masterFx: false,
    noise: "lfsr15",
    pan: "hard",
    pitch: "period",
    triangleSteps: 0,
    volumeSteps: 16,
    waveTable: null,
  },
  fmWaveforms: false,
  id: "genesis",
  kinds: ["fm", "pulse", "noise"],
  label: "Sega Genesis (YM2612 + PSG)",
  sampleRate: null,
};

const PSG_MAX = 1023;

/** PSG tone divider: f = clock / (32 * N), N 1..1023. */
export function hzToPeriod(hz: number): number {
  return Math.min(
    PSG_MAX,
    Math.max(1, Math.round(GENESIS_CLOCK_HZ / (32 * Math.max(hz, 1))))
  );
}

export function periodToHz(n: number): number {
  return GENESIS_CLOCK_HZ / (32 * n);
}

export function quantizeHz(hz: number): number {
  return periodToHz(hzToPeriod(hz));
}

/** The three fixed noise shift rates of the PSG (clock / 512, 1024, 2048). */
export const PSG_NOISE_RATES = [
  GENESIS_CLOCK_HZ / 512,
  GENESIS_CLOCK_HZ / 1024,
  GENESIS_CLOCK_HZ / 2048,
] as const;

export function quantizeNoiseRate(hz: number): number {
  const want = Math.max(hz, 1) * 16;
  let best: number = PSG_NOISE_RATES[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const rate of PSG_NOISE_RATES) {
    const d = Math.abs(Math.log(rate / want));
    if (d < bestDist) {
      bestDist = d;
      best = rate;
    }
  }
  return best;
}
