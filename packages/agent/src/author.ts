// Authoring helpers shared by the CLI's `new` command and the assistant's tools: which instrument kind a chip is
// mostly played with, and how a new song is put together (channels for the chip, each pointed at a matching project
// instrument, optionally with MML per channel).
import {
  bassKind,
  type ChannelKind,
  type ChipId,
  chipProfile,
  defaultSong,
  INSTRUMENT_PRESETS,
  type Instrument,
  type InstrumentPreset,
  instrumentForChannel,
  parseMml,
  type Song,
} from "@bleepkit/core";

// the preset machinery lives in core (the MIDI importer builds instruments with it too)
export const PRESETS = INSTRUMENT_PRESETS;
export type Preset = InstrumentPreset;

/** The kind a chip is mostly played with, used when `new instrument` gets no --kind. */
const DEFAULT_KIND: Record<ChipId, ChannelKind> = {
  adlib: "fm",
  amiga: "sample",
  c64: "sid",
  custom: "pulse",
  gameboy: "pulse",
  genesis: "fm",
  nes: "pulse",
  snes: "sample",
};

/** The kind a new instrument gets when `new instrument` is given no --kind: a bass wants its chip's bass voice. */
export function defaultKindFor(chip: ChipId, preset: Preset): ChannelKind {
  if (preset === "bass") {
    return bassKind(chip);
  }
  return preset === "bass-pulse" ? "pulse" : DEFAULT_KIND[chip];
}

/** The instrument kinds a chip can host. */
export function kindsForChip(chip: ChipId): readonly ChannelKind[] {
  return chipProfile(chip).kinds;
}

export type Template = "empty" | "loop8";

export interface SongPlan {
  /** The instruments the song needs that the project does not have: made from the per-chip presets. */
  created: Record<string, Instrument>;
  song: Song;
}

/** True when the MML plays at least one note. */
function playsNotes(mml: string): boolean {
  return parseMml(mml).events.some((e) => e.type === "note");
}

interface SongOptions {
  chip: ChipId;
  /** Make instruments from the per-chip presets for channels with MML that no project instrument suits. */
  create?: boolean;
  instruments: Record<string, Instrument>;
  mml: Record<string, string>;
  name: string;
  template: Template;
  tempo: number;
}

/**
 * A new song and the instruments it needs. A channel only gets an instrument that fits it (made for the chip or for
 * none, of the channel's kind) and, when MML is given, only a channel that plays notes gets one at all: a channel
 * with nothing to play stays empty, so a chip's spare voices are not filled with copies of the bass. With `create`,
 * a channel with MML and no fitting project instrument gets a new one from the per-chip presets (`<chip>-<role>`).
 */
export function planSong(opts: SongOptions): SongPlan {
  const song = structuredClone(defaultSong(opts.chip));
  song.name = opts.name;
  song.tempo = opts.tempo;
  const mmlDriven = Object.keys(opts.mml).length > 0;
  const known = { ...opts.instruments };
  const created: Record<string, Instrument> = {};
  for (const channel of song.channels) {
    const mml = opts.mml[channel.id];
    if (mml !== undefined) {
      channel.mml = mml;
    }
    // MML that switches with @id before anything else names its own; a channel with nothing to play gets nothing
    const wants = mmlDriven
      ? mml !== undefined && playsNotes(mml) && !mml.includes("@")
      : true;
    if (!(wants && channel.instrument === null)) {
      continue;
    }
    const pick = instrumentForChannel(opts.chip, channel, known, {
      any: !mmlDriven,
      create: opts.create === true,
    });
    channel.instrument = pick.id;
    Object.assign(created, pick.created);
    Object.assign(known, pick.created);
  }
  // MML given for any channel: the song is MML-driven, no empty pattern to pad it with silence
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
  return { created, song };
}

/** `planSong` without making instruments: only instruments the project already has. */
export function makeSong(opts: SongOptions): Song {
  return planSong({ ...opts, create: false }).song;
}
