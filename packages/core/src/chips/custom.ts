/* Custom: any kind on any channel, no constraints, free pan, master effects. The song declares its own channels;
   the profile's channels are the preview set (one per kind) the synth hosts when no song is loaded. */

import type { ChipProfile } from "../types.ts";
import { CHANNEL_KINDS } from "../types.ts";

export const CUSTOM_MAX_CHANNELS = 10;

export const CUSTOM: ChipProfile = {
  channels: CHANNEL_KINDS.map((kind) => ({
    id: kind,
    kind,
    label: kind.charAt(0).toUpperCase() + kind.slice(1),
  })),
  color: {
    bits: null,
    dac: "linear",
    gaussian: false,
    highpassHz: null,
    lowpassHz: null,
    sampleRate: null,
  },
  constraints: {
    clockHz: 1_789_773,
    dutyCycles: [],
    filter: true,
    masterFx: true,
    noise: "white",
    pan: "free",
    pitch: "free",
    triangleSteps: 0,
    volumeSteps: 0,
    waveTable: null,
  },
  fmWaveforms: true,
  id: "custom",
  kinds: CHANNEL_KINDS,
  label: "Custom (no limits)",
  sampleRate: null,
};
