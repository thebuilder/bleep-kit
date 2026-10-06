/* The bass presets, one real bass per chip (architecture section 2.5). Presets are starting points that are measured,
   not guessed: each design below aims at a strong fundamental with the character of its chip on top, so a line written
   in octaves 1 and 2 (A-1 is 55 Hz) puts real energy under 80 Hz. Nothing here touches the engine: it is only the
   numbers that fill an Instrument. */

import type {
  ChannelKind,
  ChipId,
  FmOperator,
  FmPatch,
  Instrument,
} from "./types.ts";

/**
 * The channel kind a bass wants on a chip: the NES triangle, the Game Boy wave channel, a SID voice, an FM voice, a
 * sample channel. `custom` has every kind; it gets a SID voice (a saw through the filter).
 */
export const BASS_KIND: Record<ChipId, ChannelKind> = {
  adlib: "fm",
  c64: "sid",
  custom: "sid",
  gameboy: "wave",
  genesis: "fm",
  nes: "triangle",
  snes: "sample",
};

/**
 * Game Boy wave channel bass: a rounded square (tanh of a sine) mixed 3 to 1 with a sine, in the full 4-bit range.
 * The fundamental is 14 dB over the third harmonic and the shoulders are round, so it is fat without buzzing. The
 * shipped default table is a sine, which reads as thin next to a pulse at the same level.
 */
export const GAMEBOY_BASS_TABLE: readonly number[] = [
  9, 12, 14, 14, 15, 15, 15, 15, 15, 15, 15, 15, 14, 14, 12, 9, 6, 3, 1, 1, 0,
  0, 0, 0, 0, 0, 0, 0, 1, 1, 3, 6,
];

/** Operator values in the order of the table: mult, level, decay, sustainLevel, sustainRate, detune, keyScale. */
export type OpRow = readonly [
  mult: number,
  level: number,
  decay: number,
  sustainLevel: number,
  sustainRate?: number,
  detune?: number,
  keyScale?: number,
];

export function fmOps(base: FmOperator, rows: readonly OpRow[]): FmOperator[] {
  return rows.map(
    ([mult, level, decay, sustainLevel, sustainRate, detune, keyScale]) => ({
      ...base,
      decay,
      detune: detune ?? 0,
      keyScale: keyScale ?? 0,
      level,
      mult,
      sustainLevel,
      sustainRate: sustainRate ?? 0,
    })
  );
}

/**
 * Genesis (4 op) slap bass. Algorithm 4 is two stacks added: operator 1 (feedback) over operator 2 is the slap, a
 * 1:1 pair whose modulator falls 18 dB in about a tenth of a second (decay rate 11), and operator 3 (ratio 0.5) over
 * operator 4 adds a lower body. Both carriers keep a high sustain level, so after the attack the note settles into a
 * round low tone (second harmonic about 15 dB down) and the energy sits on the fundamental.
 */
const FM4_BASS = {
  algorithm: 4,
  feedback: 6,
  rows: [
    [1, 0.6, 11, 0.12, 0, 0, 1],
    [1, 0.9, 5, 0.8],
    [0, 0.3, 11, 0.1, 0, 0, 1],
    [1, 0.5, 5, 0.85],
  ],
} as const satisfies { algorithm: number; feedback: number; rows: OpRow[] };

/**
 * AdLib (2 op) bass: operator 1 with feedback modulates operator 2 at 1:1, the modulator decaying (rate 11) to about a
 * seventh of its level, the carrier holding at a high sustain.
 */
const FM2_BASS = {
  algorithm: 0,
  feedback: 6,
  rows: [
    [1, 0.6, 11, 0.14, 0, 0, 1],
    [1, 1, 5, 0.88],
  ],
} as const satisfies { algorithm: number; feedback: number; rows: OpRow[] };

function fmBass(base: FmPatch): FmPatch {
  const spec = base.ops.length === 2 ? FM2_BASS : FM4_BASS;
  const template = base.ops[0] as FmOperator;
  return {
    algorithm: spec.algorithm,
    feedback: spec.feedback,
    lfo: null,
    ops: fmOps(template, spec.rows),
  };
}

/** The NES triangle has no volume: the note length is the shape, so the envelope is a plain gate. */
function triangleBass(base: Instrument): void {
  base.volume = 1;
  base.envelope = { attack: 0, decay: 0.1, release: 0.02, sustain: 1 };
}

function waveBass(base: Instrument): void {
  base.volume = 1;
  base.envelope = { attack: 0, decay: 0.2, release: 0.05, sustain: 0.9 };
  base.wave = { table: [...GAMEBOY_BASS_TABLE] };
}

/**
 * SID bass. c64: a pulse with slow PWM through the lowpass, moderate resonance, and a filter that starts open and
 * closes (a sweep of -0.008 per tick from 0.6 is a bright attack that has settled after a third of a second, the
 * classic SID pluck; the cutoff clamps at 0, so a note held past about a second and a quarter goes dark: retrigger
 * long notes). custom: a plain square through a lowpass at 160 Hz (the instrument format has no drive control, so
 * the resonance gives it a little bite); odd harmonics only keeps the fundamental well clear of the second.
 */
function sidBass(base: Instrument, chip: ChipId | null): void {
  base.volume = 0.6;
  base.envelope = { attack: 0, decay: 0.15, release: 0.05, sustain: 0.85 };
  if (chip === "custom") {
    base.sid = {
      filter: { cutoff: 0.28, mode: "lp", resonance: 0.2, sweep: 0 },
      pulseWidth: 0.5,
      pwmDepth: 0,
      pwmRate: 0,
      ring: false,
      sync: false,
      waveforms: ["pulse"],
    };
    return;
  }
  base.sid = {
    filter: { cutoff: 0.6, mode: "lp", resonance: 0.4, sweep: -0.008 },
    pulseWidth: 0.4,
    pwmDepth: 0.2,
    pwmRate: 0.7,
    ring: false,
    sync: false,
    waveforms: ["pulse"],
  };
}

/**
 * SNES bass: the bass sample generator (a filtered saw with a sine an octave below), tuned so note N sounds at N (the
 * generator's saw is C-4, base note 60). A fast decay to a lower sustain is the short attack transient.
 */
function sampleBass(base: Instrument): void {
  base.volume = 1;
  base.envelope = { attack: 0, decay: 0.07, release: 0.1, sustain: 0.78 };
  if (base.sample) {
    base.sample = {
      ...base.sample,
      baseNote: 60,
      generator: "bass",
      loop: true,
      params: { cutoff: 0.22, resonance: 0.1, sub: 0.25 },
    };
  }
}

/** Shape a bass instrument for its kind (and for the SID, its chip). Pulse basses keep the plain starter. */
export function shapeBass(base: Instrument, chip: ChipId | null): void {
  switch (base.kind) {
    case "triangle":
      triangleBass(base);
      break;
    case "wave":
      waveBass(base);
      break;
    case "sid":
      sidBass(base, chip);
      break;
    case "sample":
      sampleBass(base);
      break;
    case "pulse":
      base.pulse = { duty: 0.25 };
      break;
    default:
      break;
  }
  if (base.fm) {
    base.fm = fmBass(base.fm);
  }
}
