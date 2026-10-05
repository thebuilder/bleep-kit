// biome-ignore-all lint/performance/noBarrelFile: this is the @bleepkit/core/tools entry point
/* @bleepkit/core/tools: WAV, OGG and MP3 encoding, analysis, PNG writing and the analysis images (architecture
   section 1.2). Nothing here touches Node: the PNG writer takes a deflate function, and wasm-media-encoders is
   loaded lazily, so importing this module for analysis never loads WASM. */

export {
  type Analysis,
  type AnalyzeOptions,
  analyze,
} from "./tools/analysis.ts";
export {
  interleavedToResult,
  mixToMono,
  resultToInterleaved,
} from "./tools/buffers.ts";
export {
  encodeMp3,
  encodeOgg,
  MP3_ENCODER_DELAY,
  type Mp3Options,
  type OggOptions,
} from "./tools/encode.ts";
export { formatDb, formatDuration } from "./tools/format.ts";
export {
  type ImageOptions,
  type ScopesOptions,
  scopesImage,
  spectrogramImage,
  waveformImage,
} from "./tools/images.ts";
export { type PitchPoint, type PitchTrack, trackPitch } from "./tools/pitch.ts";
export { type Deflate, encodePng, type PngImage } from "./tools/png.ts";
export {
  fft,
  hann,
  type Spectrogram,
  type SpectrogramOptions,
  spectrogram,
} from "./tools/spectrum.ts";
export { decodeWav, encodeWav, type WavOptions } from "./tools/wav.ts";
