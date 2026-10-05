/* SNES (S-SMP and S-DSP) and Amiga style: eight sample voices, gaussian interpolation, echo. The 16-bit sample profile. */

import type { ChipProfile } from "../types.ts";

export const SNES_RATE = 32_000;

const channels = Array.from({ length: 8 }, (_, i) => ({
  id: `ch${i + 1}`,
  kind: "sample" as const,
  label: `Channel ${i + 1}`,
}));

export const SNES: ChipProfile = {
  channels,
  color: {
    bits: 16,
    dac: "linear",
    gaussian: true,
    highpassHz: null,
    lowpassHz: null,
    sampleRate: SNES_RATE,
  },
  constraints: {
    clockHz: SNES_RATE,
    dutyCycles: [],
    filter: false,
    masterFx: true,
    noise: "white",
    pan: "free",
    pitch: "free",
    triangleSteps: 0,
    volumeSteps: 128,
    waveTable: null,
  },
  fmWaveforms: false,
  id: "snes",
  kinds: ["sample"],
  label: "SNES (16-bit samples)",
  sampleRate: SNES_RATE,
};
