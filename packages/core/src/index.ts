// documents and types

// chips
export {
  CHIP_SFX_WAVES,
  CHIPS,
  chipChannels,
  chipProfile,
  chipSfxWaves,
} from "./chips/index.ts";
export {
  renderInstrumentNote,
  renderSfx,
  renderSong,
} from "./engine/render.ts";
export { createScopeReader } from "./engine/scope.ts";
// engine
export { createSynth } from "./engine/synth.ts";
export {
  compileSong,
  type RowMark,
  type SongTimeline,
  type TimelineEvent,
} from "./engine/timeline.ts";
export {
  type MidiFile,
  type MidiImport,
  type MidiNote,
  type MidiTempo,
  type MidiTimeSignature,
  type MidiToSongOptions,
  type MidiTrackInfo,
  midiToSong,
  type PartInfo,
  parseMidi,
  parseMidiMap,
} from "./midi/index.ts";
export { formatMml, mmlToTrack, parseMml, patternToMml } from "./mml/index.ts";
export {
  formatEffect,
  formatRowString,
  parseEffect,
  parseRowString,
} from "./normalize/effects.ts";
// documents and normalize
export {
  defaultInstrument,
  defaultProject,
  defaultSfx,
  defaultSong,
  issuesToText,
  normalizeInstrument,
  normalizeProject,
  normalizeSfx,
  normalizeSong,
} from "./normalize/index.ts";
// notes and notation
export {
  hzToNote,
  NOTE_NAMES,
  noteName,
  noteToHz,
  parseNoteName,
} from "./notes.ts";
export {
  INSTRUMENT_PRESETS,
  type InstrumentPreset,
  makeInstrument,
} from "./presets.ts";
// random
export { deriveSeed, hashString, mulberry32 } from "./prng.ts";
export { generateSample, SAMPLE_GENERATORS } from "./samples/index.ts";
export type * from "./types.ts";
export {
  CHANNEL_KINDS,
  CHIP_IDS,
  EFFECT_TYPES,
  FORMAT_VERSION,
  PPQ,
  SAMPLE_GENERATOR_IDS,
  SCOPE_FRAMES,
  SFX_CATEGORIES,
  SFX_WAVES,
} from "./types.ts";
export { ENGINE_VERSION } from "./version.ts";
