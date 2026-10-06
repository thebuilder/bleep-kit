// Starter documents: instrument presets, the per-chip starter set written by `init`, and song templates.
import {
  type ChannelKind,
  type ChipId,
  chipProfile,
  defaultSong,
  INSTRUMENT_PRESETS,
  type Instrument,
  type InstrumentPreset,
  makeInstrument,
  type Song,
} from "@bleepkit/core";

// the preset machinery lives in core (the MIDI importer builds instruments with it too)
export const PRESETS = INSTRUMENT_PRESETS;
export type Preset = InstrumentPreset;

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
