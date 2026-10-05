// Starter documents: instrument presets, the per-chip starter set written by `init`, and song templates.
import {
  type ChannelKind,
  type ChipId,
  chipProfile,
  defaultInstrument,
  defaultSong,
  type FmOperator,
  type FmPatch,
  type Instrument,
  type SampleGeneratorId,
  type Song,
} from "@bleepkit/core";

export const PRESETS = ["lead", "bass", "drums", "pad", "bell"] as const;
export type Preset = (typeof PRESETS)[number];

/** The kind a chip is mostly played with, used when `new instrument` gets no --kind. */
export const DEFAULT_KIND: Record<ChipId, ChannelKind> = {
  adlib: "fm",
  c64: "sid",
  custom: "pulse",
  gameboy: "pulse",
  genesis: "fm",
  nes: "pulse",
  snes: "sample",
};

/** lead, bass and drums instrument kinds per chip (init writes these three). */
const STARTER_KINDS: Record<ChipId, [ChannelKind, ChannelKind, ChannelKind]> = {
  adlib: ["fm", "fm", "fm"],
  c64: ["sid", "sid", "sid"],
  custom: ["pulse", "triangle", "noise"],
  gameboy: ["pulse", "wave", "noise"],
  genesis: ["fm", "fm", "noise"],
  nes: ["pulse", "triangle", "noise"],
  snes: ["sample", "sample", "sample"],
};

export function starterInstruments(
  chip: ChipId
): { id: string; instrument: Instrument }[] {
  const [lead, bass, drums] = STARTER_KINDS[chip];
  return [
    { id: "lead", instrument: makeInstrument(lead, chip, "lead", "Lead") },
    { id: "bass", instrument: makeInstrument(bass, chip, "bass", "Bass") },
    { id: "drums", instrument: makeInstrument(drums, chip, "drums", "Drums") },
  ];
}

export function kindsForChip(chip: ChipId): readonly ChannelKind[] {
  return chipProfile(chip).kinds;
}

const ENVELOPES: Record<Preset, Instrument["envelope"]> = {
  bass: { attack: 0, decay: 0.2, release: 0.08, sustain: 0.8 },
  bell: { attack: 0.001, decay: 0.9, release: 0.9, sustain: 0.05 },
  drums: { attack: 0, decay: 0.08, release: 0.02, sustain: 0 },
  lead: { attack: 0, decay: 0.15, release: 0.04, sustain: 0.6 },
  pad: { attack: 0.3, decay: 0.4, release: 0.8, sustain: 0.7 },
};

const VOLUMES: Record<Preset, number> = {
  bass: 0.9,
  bell: 0.7,
  drums: 0.9,
  lead: 0.8,
  pad: 0.6,
};

/** Operator values in the order of the table below: mult, level, decay, sustainLevel, sustainRate, detune, keyScale. */
type OpRow = readonly [
  mult: number,
  level: number,
  decay: number,
  sustainLevel: number,
  sustainRate?: number,
  detune?: number,
  keyScale?: number,
];

function ops(base: FmOperator, rows: readonly OpRow[]): FmOperator[] {
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

/*
 * Starter FM patches (levels are linear amplitudes, 1 = loudest; a modulator's level is its modulation depth). Each one
 * is written to be measured, not guessed: a modulator that decays faster than its carrier gives a bright attack that
 * settles into a duller sustain, and the feedback on operator 1 adds the edge.
 * - lead: two modulator and carrier pairs at ratios 1 and 3 (4 op algorithm 4, 5 on the 2 op chip is the same idea
 *   with one pair), a slow vibrato.
 * - bass: algorithm 0 with a decaying modulator and feedback 5, key scaled so the highs do not buzz.
 * - drums: fast decays, modulator at ratio 4 over a carrier at 1, feedback 7 (the demo-adlib tom).
 * - pad: slow attack, all carriers (or additive on 2 op), detuned pairs.
 * - bell: inharmonic-leaning ratios 3 and 7 over carriers at 1 and 2, long decay.
 */
const FM4: Record<
  Preset,
  {
    algorithm: number;
    feedback: number;
    lfo: FmPatch["lfo"];
    rows: readonly OpRow[];
  }
> = {
  bass: {
    algorithm: 0,
    feedback: 5,
    lfo: null,
    rows: [
      [1, 0.6, 9, 0.1, 6, 0, 1],
      [1, 0.4, 10, 0.1, 8],
      [1, 0.3, 12, 0.05, 10, 0, 1],
      [1, 1, 5, 0.85],
    ],
  },
  bell: {
    algorithm: 4,
    feedback: 2,
    lfo: null,
    rows: [
      [3, 0.35, 10, 0.02, 4],
      [1, 1, 8, 0.05, 2],
      [7, 0.2, 14, 0.01, 6],
      [2, 0.5, 9, 0.04, 2],
    ],
  },
  drums: {
    algorithm: 4,
    feedback: 7,
    lfo: null,
    rows: [
      [4, 0.7, 24, 0],
      [1, 1, 20, 0],
      [1, 0, 31, 0],
      [1, 0, 31, 0],
    ],
  },
  lead: {
    algorithm: 5,
    feedback: 5,
    lfo: { ampDepth: 0, pitchDepth: 12, rate: 5.5 },
    rows: [
      [1, 0.4, 7, 0.3, 0],
      [3, 0.3, 6, 0.3, 0],
      [1, 0.9, 4, 0.85],
      [1, 0.3, 4, 0.8, 0, 1],
    ],
  },
  pad: {
    algorithm: 7,
    feedback: 1,
    lfo: { ampDepth: 0.2, pitchDepth: 8, rate: 3 },
    rows: [
      [1, 0.6, 4, 0.8, 0],
      [2, 0.4, 4, 0.8, 0, -2],
      [1, 0.5, 4, 0.8, 0, 2],
      [4, 0.2, 4, 0.8],
    ],
  },
};

const FM2: Record<
  Preset,
  {
    algorithm: number;
    feedback: number;
    lfo: FmPatch["lfo"];
    rows: readonly OpRow[];
  }
> = {
  bass: {
    algorithm: 0,
    feedback: 5,
    lfo: null,
    rows: [
      [1, 0.5, 9, 0.1, 8, 0, 1],
      [1, 1, 5, 0.9],
    ],
  },
  bell: {
    algorithm: 0,
    feedback: 2,
    lfo: null,
    rows: [
      [3, 0.4, 10, 0.02, 4],
      [1, 1, 8, 0.05, 2],
    ],
  },
  drums: {
    algorithm: 0,
    feedback: 7,
    lfo: null,
    rows: [
      [4, 0.7, 24, 0],
      [1, 1, 20, 0],
    ],
  },
  lead: {
    algorithm: 0,
    feedback: 4,
    lfo: { ampDepth: 0, pitchDepth: 10, rate: 5 },
    rows: [
      [3, 0.3, 8, 0.25, 0],
      [1, 1, 6, 0.85],
    ],
  },
  pad: {
    algorithm: 1,
    feedback: 2,
    lfo: { ampDepth: 0.15, pitchDepth: 6, rate: 6 },
    rows: [
      [1, 0.7, 3, 0.9],
      [2, 0.4, 3, 0.9],
    ],
  },
};

function fmPreset(base: FmPatch, preset: Preset): FmPatch {
  const table = base.ops.length === 2 ? FM2 : FM4;
  const { algorithm, feedback, lfo, rows } = table[preset];
  const template = base.ops[0] as FmOperator;
  return {
    algorithm,
    feedback,
    lfo: lfo === null ? null : { ...lfo },
    ops: ops(template, rows),
  };
}

/** The sample generator each preset plays on the sample chip, so a bass is a bass and the drums are a kick. */
const SAMPLE_GENERATORS: Record<
  Preset,
  { generator: SampleGeneratorId; loop: boolean }
> = {
  bass: { generator: "bass", loop: true },
  bell: { generator: "bell", loop: false },
  drums: { generator: "kick", loop: false },
  lead: { generator: "lead", loop: true },
  pad: { generator: "pad", loop: true },
};

export function makeInstrument(
  kind: ChannelKind,
  chip: ChipId | null,
  preset: Preset,
  name: string
): Instrument {
  const base = structuredClone(defaultInstrument(kind, chip ?? undefined));
  base.name = name;
  base.chip = chip;
  base.volume = VOLUMES[preset];
  base.envelope = { ...ENVELOPES[preset] };
  if (preset === "drums" && kind !== "sample") {
    base.macros = {
      volume: { loop: -1, release: -1, values: [1, 0.7, 0.45, 0.25, 0.1, 0] },
    };
  }
  if (base.fm) {
    base.fm = fmPreset(base.fm, preset);
  }
  if (base.sample) {
    const { generator, loop } = SAMPLE_GENERATORS[preset];
    base.sample = { ...base.sample, generator, loop, params: {} };
    // samples are normalized by peak and sit well under a pulse in loudness: play them at full instrument volume
    base.volume = 1;
    if (preset === "drums") {
      // a one shot rings out whole: the drum envelope would cut the kick at 80 ms
      base.envelope = { attack: 0, decay: 0.4, release: 0.1, sustain: 1 };
    }
  }
  if (preset === "bass" && base.pulse) {
    base.pulse = { duty: 0.25 };
  }
  if (preset === "bell" && kind !== "noise") {
    base.macros = {
      arpeggio: { loop: -1, release: -1, values: [12, 0] },
      arpeggioMode: "offset",
    };
  }
  return base;
}

export type Template = "empty" | "loop8";

/** First project instrument whose kind matches the channel, so a new song plays something out of the box. */
function pickInstrument(
  kind: ChannelKind,
  instruments: Record<string, Instrument>
): string | null {
  const preferred = ["lead", "bass", "drums"];
  const ids = Object.keys(instruments).sort(
    (a, b) =>
      (preferred.indexOf(a) === -1 ? 99 : preferred.indexOf(a)) -
      (preferred.indexOf(b) === -1 ? 99 : preferred.indexOf(b))
  );
  return ids.find((id) => instruments[id]?.kind === kind) ?? null;
}

export function makeSong(opts: {
  chip: ChipId;
  instruments: Record<string, Instrument>;
  mml: Record<string, string>;
  name: string;
  template: Template;
  tempo: number;
}): Song {
  const song = structuredClone(defaultSong(opts.chip));
  song.name = opts.name;
  song.tempo = opts.tempo;
  for (const channel of song.channels) {
    channel.instrument ??= pickInstrument(channel.kind, opts.instruments);
    const mml = opts.mml[channel.id];
    if (mml !== undefined) {
      channel.mml = mml;
    }
  }
  // MML given for any channel: the song is MML-driven, no empty pattern to pad it with silence
  const mmlDriven = Object.keys(opts.mml).length > 0;
  if (opts.template === "loop8") {
    const length = song.rowsPerBeat * 4;
    song.patterns = {};
    song.order = [];
    for (let bar = 1; bar <= 8; bar += 1) {
      song.patterns[`bar${bar}`] = { length, tracks: {} };
      song.order.push(`bar${bar}`);
    }
    song.loop = 0;
  } else if (mmlDriven) {
    song.patterns = {};
    song.order = [];
    song.loop = null;
  }
  return song;
}
