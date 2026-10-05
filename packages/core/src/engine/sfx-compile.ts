/* Sfx compile: an Sfx document becomes a SfxProgram of precomputed per-frame coefficients (section 3.9). */

import type { ChipId, Sfx, SfxWave } from "../types.ts";
import {
  SRC_FM,
  SRC_NOISE,
  SRC_PULSE,
  SRC_SAW,
  SRC_SINE,
  SRC_TRI,
  SRC_WAVE,
  waveToBipolar,
} from "./inst.ts";

export interface SfxProgram {
  arpRate: number;
  /** Semitone offsets cycled at arpRate; the first entry is always 0. */
  arpSteps: Float32Array;
  attackFrames: number;
  bits: number;
  chip: ChipId;
  decayFrames: number;
  deltaSlide: number;
  dutyStart: number;
  dutySweep: number;
  fmIndex: number;
  fmIndexDecay: number;
  fmRatio: number;
  highpass: number;
  highpassSweep: number;
  lowpass: number;
  lowpassSweep: number;
  minHz: number;
  noiseShort: boolean;
  phaserOffsetMs: number;
  phaserSweep: number;
  punch: number;
  rateDivide: number;
  repeatFrames: number;
  resonance: number;
  sfx: Sfx;
  slide: number;
  src: number;
  startHz: number;
  sustainFrames: number;
  table: Float32Array;
  totalFrames: number;
  vibDepth: number;
  vibRate: number;
  volume: number;
}

export function sfxSource(wave: SfxWave): number {
  switch (wave) {
    case "square":
      return SRC_PULSE;
    case "triangle":
      return SRC_TRI;
    case "saw":
      return SRC_SAW;
    case "sine":
      return SRC_SINE;
    case "noise":
      return SRC_NOISE;
    case "wave":
      return SRC_WAVE;
    default:
      return SRC_FM;
  }
}

export function compileSfx(sfx: Sfx, sampleRate: number): SfxProgram {
  const env = sfx.envelope;
  const attackFrames = Math.round(env.attack * sampleRate);
  const sustainFrames = Math.round(env.sustain * sampleRate);
  const decayFrames = Math.max(1, Math.round(env.decay * sampleRate));
  const steps = new Float32Array(sfx.arpeggio.steps.length + 1);
  for (let i = 0; i < sfx.arpeggio.steps.length; i += 1) {
    steps[i + 1] = sfx.arpeggio.steps[i] ?? 0;
  }
  return {
    arpRate: sfx.arpeggio.steps.length > 0 ? sfx.arpeggio.rate : 0,
    arpSteps: steps,
    attackFrames,
    bits: sfx.bitcrush.bits ?? 0,
    chip: sfx.chip,
    decayFrames,
    deltaSlide: sfx.frequency.deltaSlide,
    dutyStart: sfx.duty.start,
    dutySweep: sfx.duty.sweep,
    fmIndex: sfx.fm?.index ?? 2,
    fmIndexDecay: sfx.fm?.indexDecay ?? 0.3,
    fmRatio: sfx.fm?.ratio ?? 2,
    highpass: sfx.filter.highpass ?? 0,
    highpassSweep: sfx.filter.highpassSweep,
    lowpass: sfx.filter.lowpass ?? 0,
    lowpassSweep: sfx.filter.lowpassSweep,
    minHz: sfx.frequency.min,
    noiseShort: sfx.noise.mode === "short",
    phaserOffsetMs: sfx.phaser.offset,
    phaserSweep: sfx.phaser.sweep,
    punch: env.punch,
    rateDivide: sfx.bitcrush.rateDivide,
    repeatFrames:
      sfx.repeat.rate > 0
        ? Math.max(1, Math.round(sampleRate / sfx.repeat.rate))
        : 0,
    resonance: sfx.filter.resonance,
    sfx,
    slide: sfx.frequency.slide,
    src: sfxSource(sfx.wave),
    startHz: sfx.frequency.start,
    sustainFrames,
    table: waveToBipolar(sfx.table ?? []),
    totalFrames: attackFrames + sustainFrames + decayFrames,
    vibDepth: sfx.vibrato.depth,
    vibRate: sfx.vibrato.rate,
    volume: sfx.volume,
  };
}
