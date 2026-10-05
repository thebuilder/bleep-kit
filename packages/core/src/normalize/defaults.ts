/* Default documents and shared default pieces. Every default is a complete, valid, normalized value. */

import { CHIPS, chipSfxWaves } from "../chips/index.ts";
import type {
  ChannelKind,
  ChipId,
  Envelope,
  FmOperator,
  FmPatch,
  Instrument,
  Project,
  Sfx,
  SidPatch,
  Song,
} from "../types.ts";
import { FORMAT_VERSION } from "../types.ts";

/** A soft sine in 4-bit steps: the default wavetable. */
export function defaultWaveTable(): number[] {
  const t: number[] = [];
  for (let i = 0; i < 32; i += 1) {
    t.push(Math.round(7.5 + 7.5 * Math.sin((2 * Math.PI * i) / 32)));
  }
  return t;
}

export function defaultEnvelope(): Envelope {
  return { attack: 0.005, decay: 0.1, sustain: 0.7, release: 0.05 };
}

export function defaultFmOperator(): FmOperator {
  return {
    mult: 1,
    detune: 0,
    level: 1,
    attack: 31,
    decay: 12,
    sustainLevel: 0.7,
    sustainRate: 0,
    release: 8,
    keyScale: 0,
    waveform: 0,
    fixedHz: null,
  };
}

/**
 * A bright electric piano style patch. 4 operators use algorithm 4 (two stacks), 2 operators use FM (0). Operator
 * levels are linear amplitudes (section 3.5): the modulators sit at 0.3 to 0.5 and decay to a fraction of that, so the
 * attack is bright (strong second and third harmonics) and the sustain is duller.
 */
export function defaultFmPatch(ops: 2 | 4 = 4): FmPatch {
  const base = defaultFmOperator();
  if (ops === 2) {
    return {
      algorithm: 0,
      feedback: 2,
      ops: [
        { ...base, mult: 1, level: 0.45, decay: 8, sustainLevel: 0.2 },
        { ...base, mult: 1, level: 1, decay: 7, sustainLevel: 0.6 },
      ],
      lfo: null,
    };
  }
  return {
    algorithm: 4,
    feedback: 3,
    ops: [
      { ...base, mult: 1, level: 0.45, decay: 8, sustainLevel: 0.2 },
      { ...base, mult: 1, level: 1, decay: 7, sustainLevel: 0.5 },
      { ...base, mult: 4, level: 0.3, decay: 12, sustainLevel: 0.06 },
      { ...base, mult: 1, level: 0.9, decay: 6, sustainLevel: 0.55 },
    ],
    lfo: null,
  };
}

export function defaultSidPatch(): SidPatch {
  return {
    waveforms: ["pulse"],
    pulseWidth: 0.5,
    pwmRate: 0,
    pwmDepth: 0,
    ring: false,
    sync: false,
    filter: { mode: "off", cutoff: 0.5, resonance: 0, sweep: 0 },
  };
}

export function defaultProject(name = "Untitled"): Project {
  return {
    version: FORMAT_VERSION,
    name,
    chip: "nes",
    sampleRate: 48_000,
    seed: 1,
    master: { volume: 0.8, limiter: true },
    export: {
      dir: "../public/audio",
      manifest: "../src/audio.ts",
      baseUrl: "/audio/",
      sfxFormat: "ogg",
      musicFormat: "ogg",
      oggQuality: 6,
      mp3Bitrate: 160,
      events: true,
      embed: false,
    },
  };
}

export function defaultSfx(chip: ChipId = "nes"): Sfx {
  const wave = chipSfxWaves(chip)[0] ?? "square";
  return {
    version: FORMAT_VERSION,
    name: "Untitled",
    category: "custom",
    chip,
    seed: 1,
    wave,
    volume: 0.7,
    frequency: { start: 440, min: 0, slide: 0, deltaSlide: 0 },
    vibrato: { depth: 0, rate: 0 },
    arpeggio: { steps: [], rate: 0 },
    envelope: { attack: 0, sustain: 0.1, punch: 0, decay: 0.2 },
    duty: { start: 0.5, sweep: 0 },
    repeat: { rate: 0 },
    phaser: { offset: 0, sweep: 0 },
    filter: {
      lowpass: null,
      lowpassSweep: 0,
      resonance: 0,
      highpass: null,
      highpassSweep: 0,
    },
    bitcrush: { bits: null, rateDivide: 1 },
    noise: { mode: "long" },
    fm: wave === "fm" ? { ratio: 2, index: 2, indexDecay: 0.3 } : null,
    table: wave === "wave" ? defaultWaveTable() : null,
  };
}

export function defaultInstrument(
  kind: ChannelKind,
  chip: ChipId | null = null
): Instrument {
  const fmOps =
    chip === null
      ? 4
      : (CHIPS[chip].channels.find((c) => c.kind === "fm")?.fmOps ?? 4);
  return {
    version: FORMAT_VERSION,
    name: "Untitled",
    kind,
    chip,
    volume: 0.8,
    pan: 0,
    transpose: 0,
    finetune: 0,
    envelope: defaultEnvelope(),
    macros: {},
    send: { echo: 0, reverb: 0 },
    pulse: kind === "pulse" ? { duty: 0.5 } : null,
    wave: kind === "wave" ? { table: defaultWaveTable() } : null,
    noise: kind === "noise" ? { mode: "long" } : null,
    sid: kind === "sid" ? defaultSidPatch() : null,
    fm: kind === "fm" ? defaultFmPatch(fmOps) : null,
    sample:
      kind === "sample"
        ? {
            generator: "pluck",
            params: { brightness: 0.6, damp: 0.3, pick: 0.5 },
            seed: 1,
            baseNote: 60,
            loop: false,
          }
        : null,
  };
}

/** A fresh song for a chip: its channels, one 64 row pattern, loop to the start. */
export function defaultSong(chip: ChipId = "nes"): Song {
  const profile = CHIPS[chip];
  return {
    version: FORMAT_VERSION,
    name: "Untitled",
    chip,
    tempo: 120,
    rowsPerBeat: 4,
    tickRate: 60,
    channels: profile.channels.map((c) => ({
      id: c.id,
      kind: c.kind,
      instrument: null,
      volume: 1,
      pan: 0,
      mml: null,
      muted: false,
    })),
    patterns: { "pattern-1": { length: 64, tracks: {} } },
    order: ["pattern-1"],
    loop: 0,
    master: { volume: 0.8, echo: null, reverb: null },
  };
}
