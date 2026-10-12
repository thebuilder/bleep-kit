/* Amiga (Paula): four 8-bit sample channels, channels 1 and 4 left and 2 and 3 right, volume 0 to 64, pitch set by a
   period register (the sample plays at clock / period frames per second), nearest sample playback, the A500's fixed
   output lowpass and the switchable LED filter. No echo. */

import type { ChipProfile } from "../types.ts";

/** Paula's clock on a PAL machine, the one ProTracker tunes to. */
export const AMIGA_CLOCK_HZ = 3_546_895;
/** ProTracker's three octaves: period 856 (C-1) down to 113 (B-3). Notes inside play as the trackers do. */
export const AMIGA_PERIOD_MIN = 113;
export const AMIGA_PERIOD_MAX = 856;
/** The extended range the engine plays (one octave beyond each end). Outside the standard range normalize warns. */
export const AMIGA_PERIOD_EXT_MIN = 56;
export const AMIGA_PERIOD_EXT_MAX = 1712;
/** ProTracker's C-2 has period 428; Bleepkit names that note C-2 as well (MIDI note 36), so MOD note names carry over. */
export const MOD_C2_PERIOD = 428;
export const MOD_C2_NOTE = 36;
/** The rate a MOD sample plays at on its C-2: the clock divided by 428. */
export const MOD_SAMPLE_RATE = 8287;
/** The lowest and highest note ProTracker can write (C-1 and B-3). */
export const MOD_NOTE_LOW = 24;
export const MOD_NOTE_HIGH = 59;
/** The A500's fixed output filter (one pole), the LED filter (two poles) and the DC blocker. */
export const AMIGA_A500_LOWPASS_HZ = 4421;
export const AMIGA_LED_HZ = 3091;
export const AMIGA_LED_Q = 0.66;
export const AMIGA_HIGHPASS_HZ = 5.2;
/** Generated samples (presets, the sample generators) are made at this rate: period 320, so the base note plays at 320. */
export const AMIGA_GENERATOR_RATE = 11_084;
/** The rate user samples are resampled to on import by default (period 214, ProTracker's C-3). */
export const AMIGA_IMPORT_RATE = 16_574;

/** Hardware pan of the four channels: 1 and 4 left, 2 and 3 right. */
const PANS = [-1, 1, 1, -1] as const;

export const AMIGA: ChipProfile = {
  channels: PANS.map((pan, i) => ({
    id: `ch${i + 1}`,
    kind: "sample" as const,
    label: `Channel ${i + 1}`,
    pan,
  })),
  color: {
    bits: null,
    dac: "linear",
    gaussian: false,
    highpassHz: AMIGA_HIGHPASS_HZ,
    lowpassHz: AMIGA_A500_LOWPASS_HZ,
    sampleRate: null,
  },
  constraints: {
    clockHz: AMIGA_CLOCK_HZ,
    dutyCycles: [],
    filter: false,
    masterFx: false,
    noise: "white",
    pan: "fixed",
    pitch: "period",
    triangleSteps: 0,
    volumeSteps: 65,
    waveTable: null,
  },
  fmWaveforms: false,
  id: "amiga",
  kinds: ["sample"],
  label: "Amiga (Paula)",
  sampleRate: AMIGA_GENERATOR_RATE,
};

/** ProTracker's period table for finetune 0, C-1 (note 24) to B-3 (note 59). */
export const PROTRACKER_PERIODS: readonly number[] = [
  856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453, 428, 404, 381,
  360, 339, 320, 302, 285, 269, 254, 240, 226, 214, 202, 190, 180, 170, 160,
  151, 143, 135, 127, 120, 113,
];

/** The period register that plays `rate` frames per second, as an integer, clamped to the extended range. */
export function rateToPeriod(rate: number): number {
  const p = Math.round(AMIGA_CLOCK_HZ / Math.max(1, rate));
  return Math.min(AMIGA_PERIOD_EXT_MAX, Math.max(AMIGA_PERIOD_EXT_MIN, p));
}

/** The playback rate Paula really produces for a wanted rate: periods are whole numbers. */
export function quantizeRate(rate: number): number {
  return AMIGA_CLOCK_HZ / rateToPeriod(rate);
}

/** The period a wanted rate needs, without clamping or rounding. */
export function exactPeriod(rate: number): number {
  return AMIGA_CLOCK_HZ / Math.max(1, rate);
}

/** Whether a period is inside ProTracker's standard range. */
export function periodInStandardRange(period: number): boolean {
  return period >= AMIGA_PERIOD_MIN - 0.5 && period <= AMIGA_PERIOD_MAX + 0.5;
}

/** The ProTracker period of a note: C-2 (36) is 428, an octave up halves it. */
export function noteToPeriod(note: number): number {
  return MOD_C2_PERIOD * 2 ** ((MOD_C2_NOTE - note) / 12);
}

/** The note (fractional) a period stands for. */
export function periodToNote(period: number): number {
  return MOD_C2_NOTE + 12 * Math.log2(MOD_C2_PERIOD / Math.max(1, period));
}

/** The table period of a whole note from 24 to 59, or null outside ProTracker's range. */
export function tablePeriod(note: number): number | null {
  const i = Math.round(note) - MOD_NOTE_LOW;
  return PROTRACKER_PERIODS[i] ?? null;
}

/** The whole note whose table period is nearest (in pitch) to `period`. May lie outside 24 to 59 for extended periods. */
export function nearestNote(period: number): number {
  return Math.round(periodToNote(period));
}
