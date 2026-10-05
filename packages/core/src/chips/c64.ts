/* Commodore 64 (MOS 6581/8580 SID): three voices with tri, saw, pulse, noise, ring mod, sync and one shared filter. */

import type { ChipProfile } from "../types.ts";

export const C64_CLOCK_HZ = 985_248;

export const C64: ChipProfile = {
  channels: [
    { id: "voice1", kind: "sid", label: "Voice 1" },
    { id: "voice2", kind: "sid", label: "Voice 2" },
    { id: "voice3", kind: "sid", label: "Voice 3" },
  ],
  color: {
    bits: null,
    dac: "sid",
    gaussian: false,
    highpassHz: null,
    lowpassHz: 16_000,
    sampleRate: null,
  },
  constraints: {
    clockHz: C64_CLOCK_HZ,
    dutyCycles: [],
    filter: true,
    masterFx: false,
    noise: "lfsr23",
    pan: "none",
    pitch: "period",
    triangleSteps: 0,
    volumeSteps: 16,
    waveTable: null,
  },
  fmWaveforms: false,
  id: "c64",
  kinds: ["sid"],
  label: "Commodore 64 (SID)",
  sampleRate: null,
};

const ACC_RANGE = 16_777_216;

/** 16-bit frequency register: F = hz * 2^24 / clock. */
export function hzToPeriod(hz: number): number {
  return Math.min(
    65_535,
    Math.max(1, Math.round((Math.max(hz, 0) * ACC_RANGE) / C64_CLOCK_HZ))
  );
}

export function periodToHz(f: number): number {
  return (f * C64_CLOCK_HZ) / ACC_RANGE;
}

export function quantizeHz(hz: number): number {
  return periodToHz(hzToPeriod(hz));
}
