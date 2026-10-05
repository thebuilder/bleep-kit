/* NES (Ricoh 2A03 APU): two pulse channels, triangle, noise. 4-bit stepped volumes, period registers, non-linear mixer. */

import type { ChipProfile } from "../types.ts";

const NES_CLOCK_HZ = 1_789_773;
const NES_DUTIES = [0.125, 0.25, 0.5, 0.75] as const;

export const NES: ChipProfile = {
  channels: [
    { id: "pulse1", kind: "pulse", label: "Pulse 1" },
    { id: "pulse2", kind: "pulse", label: "Pulse 2" },
    { id: "triangle", kind: "triangle", label: "Triangle" },
    { id: "noise", kind: "noise", label: "Noise" },
  ],
  color: {
    bits: null,
    dac: "nes",
    gaussian: false,
    highpassHz: 37,
    lowpassHz: 14_000,
    sampleRate: null,
  },
  constraints: {
    clockHz: NES_CLOCK_HZ,
    dutyCycles: NES_DUTIES,
    filter: false,
    masterFx: false,
    noise: "lfsr7-15",
    pan: "none",
    pitch: "period",
    triangleSteps: 32,
    volumeSteps: 16,
    waveTable: null,
  },
  fmWaveforms: false,
  id: "nes",
  kinds: ["pulse", "triangle", "noise"],
  label: "NES (2A03)",
  sampleRate: null,
};

/** Noise timer periods in CPU cycles (NTSC). The LFSR is clocked once per period. */
const NES_NOISE_PERIODS = [
  4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068,
] as const;

const PULSE_MIN_PERIOD = 8;
const REGISTER_MAX = 2047;

/** Timer register for a pulse frequency: round(clock / (16 * hz)) - 1, clamped to the 11-bit range. */
export function hzToPeriod(
  hz: number,
  kind: "pulse" | "triangle" = "pulse"
): number {
  const div = kind === "pulse" ? 16 : 32;
  const t = Math.round(NES_CLOCK_HZ / (div * Math.max(hz, 1))) - 1;
  const min = kind === "pulse" ? PULSE_MIN_PERIOD : 2;
  return Math.min(REGISTER_MAX, Math.max(min, t));
}

export function periodToHz(
  period: number,
  kind: "pulse" | "triangle" = "pulse"
): number {
  const div = kind === "pulse" ? 16 : 32;
  return NES_CLOCK_HZ / (div * (period + 1));
}

/** The pitch the hardware actually plays for a requested frequency. */
export function quantizePulseHz(hz: number): number {
  return periodToHz(hzToPeriod(hz, "pulse"), "pulse");
}

export function quantizeTriangleHz(hz: number): number {
  return periodToHz(hzToPeriod(hz, "triangle"), "triangle");
}

/** LFSR clock in Hz of the noise period closest (in pitch) to hz * 16. */
export function quantizeNoiseRate(hz: number): number {
  const want = Math.max(hz, 1) * 16;
  let best = NES_CLOCK_HZ / NES_NOISE_PERIODS[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const p of NES_NOISE_PERIODS) {
    const rate = NES_CLOCK_HZ / p;
    const d = Math.abs(Math.log(rate / want));
    if (d < bestDist) {
      bestDist = d;
      best = rate;
    }
  }
  return best;
}
