// documents and types

export {
  AMIGA_CLOCK_HZ,
  AMIGA_GENERATOR_RATE,
  AMIGA_IMPORT_RATE,
  AMIGA_PERIOD_EXT_MAX,
  AMIGA_PERIOD_EXT_MIN,
  AMIGA_PERIOD_MAX,
  AMIGA_PERIOD_MIN,
  MOD_C2_NOTE,
  MOD_NOTE_HIGH,
  MOD_NOTE_LOW,
  MOD_SAMPLE_RATE,
  noteToPeriod,
  periodToNote,
} from "./chips/amiga.ts";
export {
  DAC_RATE_MAX,
  DAC_RATE_MIN,
  GENESIS_DAC_RATE,
  quantizeDacRate,
} from "./chips/genesis.ts";
// chips
export {
  CHIP_SFX_WAVES,
  CHIPS,
  chipChannels,
  chipProfile,
  chipSfxWaves,
  hardwareChannels,
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
  CHORD_MODES,
  type ChordMode,
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
  type ModCell,
  type ModExport,
  type ModFile,
  type ModImport,
  type ModInfo,
  type ModParse,
  type ModSample,
  type ModToSongOptions,
  modToSong,
  parseMod,
  songToMod,
} from "./mod/index.ts";
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
  defaultSample,
  defaultSfx,
  defaultSong,
  issuesToText,
  normalizeInstrument,
  normalizeProject,
  normalizeSample,
  normalizeSfx,
  normalizeSong,
  sampleFits,
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
  bassKind,
  INSTRUMENT_PRESETS,
  type InstrumentPreset,
  makeInstrument,
} from "./presets.ts";
// random
export { deriveSeed, hashString, mulberry32 } from "./prng.ts";
export {
  CREDITS_FILE,
  CREDITS_HEADER,
  creditedSources,
  creditsText,
} from "./samples/credits.ts";
export { generateSample, SAMPLE_GENERATORS } from "./samples/index.ts";
export {
  base64ByteLength,
  base64ToBytes,
  bytesToBase64,
  decodeSampleData,
  encodeSampleData,
  type ImportedSample,
  importBits,
  importRate,
  isBase64,
  mixToMonoChannels,
  normalizePeak,
  peakOf,
  prepareImport,
  quantize8,
  removeDc,
  resample,
  sampleFrames,
  sampleFromData,
  scalePosition,
  usedSamples,
} from "./samples/user.ts";
export {
  chipFits,
  fittingInstruments,
  instrumentFits,
  misfitReason,
} from "./songs/instrument-fit.ts";
export {
  channelInstrumentIds,
  channelRole,
  type FixResult,
  findMisfits,
  fixMisfits,
  type InstrumentMisfit,
  type InstrumentSwap,
  instrumentForChannel,
  mmlInstrumentIds,
  PRESET_FOR_ROLE,
} from "./songs/instrument-fix.ts";
export {
  describeRechip,
  type RechipChange,
  type RechipDrop,
  type RechipMove,
  type RechipResult,
  type RechipSummary,
  rechipSong,
} from "./songs/rechip.ts";
export type * from "./types.ts";
export {
  CHANNEL_KINDS,
  CHIP_IDS,
  EFFECT_TYPES,
  FORMAT_VERSION,
  PPQ,
  SAMPLE_BITS,
  SAMPLE_GENERATOR_IDS,
  SAMPLE_MAX_BYTES,
  SCOPE_FRAMES,
  SFX_CATEGORIES,
  SFX_WAVES,
} from "./types.ts";
export { ENGINE_VERSION } from "./version.ts";
