/* Instrument runtime: an Instrument compiled for one chip at one sample rate (load time, never inside process). */

import { CHIPS } from "../chips/index.ts";
import type { FmRt } from "../dsp/fm.ts";
import { compileFmPatch } from "../dsp/fm.ts";
import type { MacroRt } from "../dsp/macro.ts";
import { compileMacro } from "../dsp/macro.ts";
import { nearest } from "../nearest.ts";
import type { ChannelKind, ChipId, ChipProfile, Instrument } from "../types.ts";

/** Sample data a voice can play (SNES profile). */
export interface SampleRt {
  baseNote: number;
  data: Float32Array;
  loopEnd: number;
  loopStart: number;
  loops: boolean;
  rate: number;
}

/** Source models a voice can run. */
export const SRC_PULSE = 0;
export const SRC_TRI = 1;
export const SRC_SAW = 2;
export const SRC_SINE = 3;
export const SRC_NOISE = 4;
export const SRC_WAVE = 5;
export const SRC_FM = 6;
export const SRC_SID = 7;
export const SRC_SAMPLE = 8;

export const DEFAULT_DUTIES: readonly number[] = [0.125, 0.25, 0.5, 0.75];

function sourceOfKind(kind: ChannelKind): number {
  switch (kind) {
    case "pulse":
      return SRC_PULSE;
    case "triangle":
      return SRC_TRI;
    case "noise":
      return SRC_NOISE;
    case "wave":
      return SRC_WAVE;
    case "sid":
      return SRC_SID;
    case "fm":
      return SRC_FM;
    default:
      return SRC_SAMPLE;
  }
}

export interface InstRt {
  arpFixed: boolean;
  attack: number;
  chip: ChipId;
  decay: number;
  /** Chip duty list in use for the duty macro and base duty. */
  duties: readonly number[];
  duty: number;
  finetune: number;
  /** Compiled FM patch for fm instruments. */
  fm: FmRt | null;
  id: string;
  inst: Instrument;
  kind: ChannelKind;
  macroArp: MacroRt;
  macroDuty: MacroRt;
  macroPan: MacroRt;
  macroPitch: MacroRt;
  macroVolume: MacroRt;
  noiseShort: boolean;
  pan: number;
  release: number;
  /** Generated sample for sample instruments. */
  sample: SampleRt | null;
  sendEcho: number;
  sendReverb: number;
  src: number;
  sustain: number;
  transpose: number;
  volume: number;
  /** Wavetable as bipolar steps (4-bit values mapped to -1..1). */
  wave: Float32Array;
}

export function waveToBipolar(table: readonly number[]): Float32Array {
  const out = new Float32Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = (table[i] ?? 0) / 7.5 - 1;
  }
  return out;
}

export function compileInstrument(
  id: string,
  inst: Instrument,
  chip: ChipId,
  profile: ChipProfile = CHIPS[chip]
): InstRt {
  const list =
    profile.constraints.dutyCycles.length > 0
      ? profile.constraints.dutyCycles
      : DEFAULT_DUTIES;
  const baseDuty = inst.pulse?.duty ?? 0.5;
  return {
    arpFixed: inst.macros.arpeggioMode === "fixed",
    attack: inst.envelope.attack,
    chip,
    decay: inst.envelope.decay,
    duties: list,
    duty:
      profile.constraints.dutyCycles.length > 0
        ? nearest(list, baseDuty)
        : baseDuty,
    finetune: inst.finetune,
    fm: inst.fm
      ? compileFmPatch(
          inst.fm,
          profile.channels.find((c) => c.kind === "fm")?.fmOps ?? null,
          profile.fmWaveforms
        )
      : null,
    id,
    inst,
    kind: inst.kind,
    macroArp: compileMacro(inst.macros.arpeggio),
    macroDuty: compileMacro(inst.macros.duty),
    macroPan: compileMacro(inst.macros.pan),
    macroPitch: compileMacro(inst.macros.pitch),
    macroVolume: compileMacro(inst.macros.volume),
    noiseShort: inst.noise?.mode === "short",
    pan: inst.pan,
    release: inst.envelope.release,
    sample: null,
    sendEcho: inst.send.echo,
    sendReverb: inst.send.reverb,
    src: sourceOfKind(inst.kind),
    sustain: inst.envelope.sustain,
    transpose: inst.transpose,
    volume: inst.volume,
    wave: waveToBipolar(inst.wave?.table ?? []),
  };
}
