/* AdLib / Sound Blaster (Yamaha OPL2 YM3812): nine 2-operator FM voices with waveform select. */

import type { ChipProfile } from "../types.ts";

const ADLIB_CLOCK_HZ = 3_579_545;

const channels = Array.from({ length: 9 }, (_, i) => ({
  fmOps: 2 as const,
  id: `fm${i + 1}`,
  kind: "fm" as const,
  label: `FM ${i + 1}`,
}));

export const ADLIB: ChipProfile = {
  channels,
  color: {
    bits: null,
    dac: "linear",
    gaussian: false,
    highpassHz: null,
    lowpassHz: 16_000,
    sampleRate: null,
  },
  constraints: {
    clockHz: ADLIB_CLOCK_HZ,
    dutyCycles: [],
    filter: false,
    masterFx: false,
    noise: "white",
    pan: "none",
    pitch: "free",
    triangleSteps: 0,
    volumeSteps: 64,
    waveTable: null,
  },
  fmWaveforms: true,
  id: "adlib",
  kinds: ["fm"],
  label: "AdLib (OPL2)",
  sampleRate: null,
};
