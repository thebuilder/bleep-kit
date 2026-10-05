# Bleepkit architecture

This document is the contract between six engineers working in parallel. Everything here is decided; when the text and your instinct disagree, follow the text and raise the disagreement with the orchestrator instead of improvising. Section 10 says which files you own. Never edit a file you do not own.

Style rule for every file in the repository, docs and comments included: never use the em dash character. Use commas, colons or hyphens.

Bleepkit generates 80s and 90s style game audio (chiptune and FM era) for browser games. It is used two ways: by a person through the studio web app, and by an AI agent through the CLI. The agent cannot hear, so every document is plain JSON with a text notation for music (MML), every render can be measured (`bleepkit analyze`), and every measurement has a `--json` form.

## 0. Conventions (mirrors Pixelkit)

- pnpm workspace, Turbo, TypeScript, Vitest. Node 22.18 or newer runs `.ts` sources directly with type stripping, so: no enums, no namespaces, no parameter properties, no `const enum`. Use `as const` arrays plus union types.
- `tsconfig.base.json` is strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`. Relative imports always end in `.ts`. Type-only imports use `import type`.
- Each package exposes `src/index.ts` (public API) and, where it applies, `src/tools.ts` (`@bleepkit/<pkg>/tools`, what the CLI, studio and tests share). `package.json` `exports` point at `./src/index.ts` and `./src/tools.ts`; `publishConfig.exports` point at `dist/`.
- Every document is plain JSON validated by a `normalize*` function that fills defaults, clamps, and reports what is wrong (section 2.1). Nothing downstream ever reads un-normalized JSON.
- Determinism: all randomness goes through the seeded PRNG in `@bleepkit/core` (`mulberry32`, the same function as Pixelkit). `Math.random` and `Date` are forbidden in `packages/core`, `packages/sfx` and `packages/player` source (a lint test greps for them). The CLI may use `Date` only for the `generatedAt` manifest comment and for log timestamps.
- Tests live in `<package>/test/**/*.test.ts` and are picked up by the root `vitest.config.ts` (owned by the scaffolder). Studio DOM tests use `happy-dom`.
- Biome via Ultracite for lint and format (root config owned by the scaffolder). Do not fight the formatter.
- Units in JSON: seconds for time, Hz for frequency, 0 to 1 for levels and amounts unless the field says otherwise, MIDI note numbers (60 = C-4 = 261.63 Hz, A-4 = 69 = 440 Hz) for pitch, cents for fine pitch, semitones for coarse pitch, pan -1 (left) to 1 (right).

## 1. Packages and dependency graph

```
packages/core      @bleepkit/core        DSP engine, document types, normalize, MML, chip profiles, sample generators
                   @bleepkit/core/tools  WAV encode, OGG/MP3 encode (wasm-media-encoders), analysis, PNG writer, images
packages/sfx       @bleepkit/sfx         sfxr-style generators per category, randomize, mutate, describe
packages/player    @bleepkit/player      game runtime: AudioWorklet node, file playback, loops, polyphony, buses, events
                   @bleepkit/player/worklet   the AudioWorklet processor module (bundled by the consumer's Vite)
packages/cli       bleepkit (bin)        project folder commands, render/export pipeline, studio server
apps/studio        @bleepkit/studio      Vite app, vanilla TypeScript, canvas views, Pixelkit backdrop
```

Dependency graph (an arrow means "imports from"):

```
sfx ----> core
player --> core
cli ----> core, core/tools, sfx, (serves apps/studio/dist)
studio --> core, core/tools, sfx, player, (ejected Pixelkit files under apps/studio/src/pixelkit/)
```

Rules:

- `core` imports nothing from the workspace and nothing from npm at runtime. `core/tools` imports `wasm-media-encoders` only, lazily (dynamic import inside `encodeOgg` / `encodeMp3`), so importing `@bleepkit/core/tools` for analysis never loads WASM.
- `core` must run inside an AudioWorkletGlobalScope: no `TextEncoder`, `performance`, `setTimeout`, `console` in engine code paths (console is allowed in normalize for warnings only through an injectable `warn` callback, default no-op).
- `player` is the only package that touches Web Audio.
- `cli` is the only package that touches the file system and the network.
- `studio` never imports from `cli`; it talks to the CLI's server over HTTP and a WebSocket (section 6.3).

### 1.1 Public API of @bleepkit/core (`src/index.ts`)

```ts
// documents and normalize
export { FORMAT_VERSION, CHIP_IDS, CHANNEL_KINDS, SFX_CATEGORIES, SFX_WAVES, EFFECT_TYPES, SAMPLE_GENERATOR_IDS, PPQ, SCOPE_FRAMES } from "./types.ts";
export { ENGINE_VERSION } from "./version.ts";   // a string ("2" today): the version of the sound, bumped when golden hashes change on purpose (section 6.2)
export type * from "./types.ts";
export { normalizeProject, normalizeSfx, normalizeInstrument, normalizeSong, defaultProject, defaultSfx, defaultInstrument, defaultSong } from "./normalize/index.ts";
export { issuesToText } from "./normalize/issues.ts";
export { parseEffect, formatEffect, parseRowString, formatRowString } from "./normalize/effects.ts";

// notes and notation
export { noteToHz, hzToNote, noteName, parseNoteName, NOTE_NAMES } from "./notes.ts";
export { parseMml, formatMml, mmlToTrack, patternToMml } from "./mml/index.ts";
export { compileSong, type SongTimeline, type TimelineEvent } from "./engine/timeline.ts";

// chips
export { CHIPS, chipProfile, chipChannels } from "./chips/index.ts";

// engine
export { createSynth } from "./engine/synth.ts";
export { renderSfx, renderSong, renderInstrumentNote } from "./engine/render.ts";
export { createScopeReader } from "./engine/scope.ts";

// sample generators (the 16-bit profile's instruments)
export { SAMPLE_GENERATORS, generateSample } from "./samples/index.ts";

// random
export { mulberry32, hashString, deriveSeed } from "./prng.ts";
```

Signatures (full detail in sections 2 to 4):

```ts
function normalizeProject(input: unknown): Normalized<Project>;
function normalizeSfx(input: unknown): Normalized<Sfx>;
function normalizeInstrument(input: unknown): Normalized<Instrument>;
function normalizeSong(input: unknown, instruments?: Record<string, Instrument>): Normalized<Song>;
function defaultProject(name?: string): Project;      // and defaultSfx(chip?), defaultInstrument(kind, chip?), defaultSong(chip?)
function issuesToText(issues: readonly Issue[]): string;  // one issue per line: "error /envelope/attack: must be 0 to 4 (was 9)"

function noteToHz(note: number, cents?: number): number;          // 69 -> 440
function hzToNote(hz: number): number;                            // fractional MIDI note
function noteName(note: number): string;                          // 60 -> "C-4", 61 -> "C#4"
function parseNoteName(s: string): number | null;                 // "C#4" -> 61, "c+4" -> 61, "Db4" -> 61, else null
const NOTE_NAMES: readonly ["C-","C#","D-","D#","E-","F-","F#","G-","G#","A-","A#","B-"];

function parseMml(src: string, opts?: MmlOptions): { events: MmlEvent[]; issues: Issue[]; loopPulse: number | null; tempo: number | null };
function formatMml(events: readonly MmlEvent[], opts?: MmlOptions): string;
function mmlToTrack(src: string, rowsPerBeat: number, opts?: MmlOptions): { rows: Row[]; issues: Issue[]; loopRow: number | null };
function patternToMml(rows: readonly Row[], rowsPerBeat: number): string;
function parseEffect(code: string): Effect | null;                  // "A0F" -> { type: "volSlide", x: 0, y: 15 }
function formatEffect(e: Effect): string;
function parseRowString(s: string, row: number): { row: Row; issues: Issue[] };
function formatRowString(r: Row): string;
function compileSong(song: Song, instruments: Record<string, Instrument>): SongTimeline;
// SongTimeline: the merged, pattern-and-MML-independent event list the sequencer plays.
interface SongTimeline {
  channels: readonly ChipChannel[];
  /** Per channel, sorted by pulse: note on/off, instrument, volume, pan and effect changes. */
  tracks: TimelineEvent[][];
  /** Pulse at which each order entry starts, plus the end pulse as the last entry. */
  orderStarts: number[];
  loopPulse: number | null;
  totalPulses: number;
  /** Tempo changes as [pulse, bpm], starting with [0, song.tempo]. */
  tempos: [number, number][];
}
type TimelineEvent =
  | { type: "note"; pulse: number; note: number; inst: string | null; vol: number | null; fx: Effect[]; order: number; row: number }
  | { type: "off"; pulse: number; order: number; row: number }
  | { type: "release"; pulse: number; order: number; row: number }
  | { type: "fx"; pulse: number; fx: Effect[]; vol: number | null; inst: string | null; order: number; row: number };

const CHIPS: Readonly<Record<ChipId, ChipProfile>>;
function chipProfile(id: ChipId): ChipProfile;
function chipChannels(song: Song): readonly ChipChannel[];        // the profile's channels, or the song's own for "custom"

function createSynth(opts: SynthOptions): Synth;
function renderSfx(sfx: Sfx, opts?: RenderOptions): RenderResult;
function renderSong(song: Song, instruments: Record<string, Instrument>, opts?: RenderOptions): RenderResult;
function renderInstrumentNote(inst: Instrument, note: number, opts?: RenderOptions & { chip?: ChipId; duration?: number; release?: number }): RenderResult;

const SAMPLE_GENERATORS: Readonly<Record<SampleGeneratorId, SampleGeneratorSpec>>;
function generateSample(gen: SampleGeneratorId, params: Record<string, number>, seed: number, sampleRate: number): GeneratedSample;

function mulberry32(seed: number): () => number;                   // [0, 1), identical to Pixelkit's
function hashString(s: string): number;                            // FNV-1a 32-bit, for ids -> seeds
function deriveSeed(seed: number, salt: number | string): number;  // a child seed, stable
```

### 1.2 Public API of @bleepkit/core/tools (`src/tools.ts`)

```ts
export { encodeWav, decodeWav, type WavOptions } from "./tools/wav.ts";
export { encodeOgg, encodeMp3, type OggOptions, type Mp3Options } from "./tools/encode.ts";
export { analyze, type Analysis, type AnalyzeOptions } from "./tools/analysis.ts";
export { fft, hann, type Spectrogram, spectrogram } from "./tools/spectrum.ts";
export { trackPitch, type PitchTrack } from "./tools/pitch.ts";
export { encodePng, type PngImage, type Deflate } from "./tools/png.ts";
export { waveformImage, spectrogramImage, scopesImage, type ImageOptions } from "./tools/images.ts";
export { resultToInterleaved, interleavedToResult, mixToMono } from "./tools/buffers.ts";
export { formatDuration, formatDb } from "./tools/format.ts";
```

```ts
function encodeWav(r: RenderResult, opts?: WavOptions): Uint8Array;   // PCM, bits 16 (default) or 24 or 32-float, writes a smpl chunk when r.loopStart is set
function decodeWav(bytes: Uint8Array): RenderResult;                   // 8/16/24/32 PCM and 32-float, reads smpl loop
function encodeOgg(r: RenderResult, opts?: OggOptions): Promise<Uint8Array>;  // quality -1..10, default 6
function encodeMp3(r: RenderResult, opts?: Mp3Options): Promise<Uint8Array>;  // bitrate kbps, default 160
function analyze(r: RenderResult, opts?: AnalyzeOptions): Analysis;
function spectrogram(mono: Float32Array, sampleRate: number, opts?: { size?: 1024; hop?: 256 }): Spectrogram;
function trackPitch(mono: Float32Array, sampleRate: number, opts?: { window?: 2048; hop?: 512; minHz?: 30; maxHz?: 5000 }): PitchTrack;
function encodePng(img: PngImage, deflate?: Deflate): Uint8Array;      // RGBA; without deflate it writes stored (uncompressed) deflate blocks
function waveformImage(r: RenderResult, opts?: ImageOptions): PngImage;
function spectrogramImage(r: RenderResult, opts?: ImageOptions): PngImage;
function scopesImage(r: RenderResult, opts?: ImageOptions & { frame?: number; window?: number }): PngImage; // needs r.stems
```

`Deflate` is `(data: Uint8Array) => Uint8Array`. The CLI passes `(d) => new Uint8Array(zlib.deflateSync(d))`; the browser passes nothing (bigger files, still valid PNG). This keeps `core/tools` free of Node imports.

### 1.3 Public API of @bleepkit/sfx (`src/index.ts`)

```ts
export const SFX_CATEGORIES: readonly SfxCategory[];            // re-exported from core types for convenience
export function generateSfx(category: SfxCategory, opts: { seed: number; chip?: ChipId; name?: string }): Sfx;
export function randomizeSfx(sfx: Sfx, seed: number): Sfx;        // new values within the sfx's category ranges, same chip
export function mutateSfx(sfx: Sfx, opts: { seed: number; amount?: number }): Sfx;  // amount 0..1, default 0.15: nudge a random subset of fields
export function mutateMany(sfx: Sfx, opts: { seed: number; amount?: number; count: number }): Sfx[];  // deterministic family
export function describeSfx(sfx: Sfx): string;                    // one paragraph for agents: "A short rising square blip, 0.18 s, duty 25%, ..."
export function categoryRanges(category: SfxCategory): SfxRanges; // the parameter ranges a category draws from
export type { SfxRanges } from "./ranges.ts";
```

All functions are pure. The returned `Sfx` is already normalized (they call `normalizeSfx` before returning and assert zero error issues in tests).

### 1.4 Public API of @bleepkit/player (`src/index.ts`)

```ts
export function createPlayer(opts?: PlayerOptions): Promise<BleepPlayer>;
export function loadManifest(url: string): Promise<AudioManifest>;      // fetches a JSON manifest (section 7) when you do not import audio.ts
export type { BleepPlayer, PlayerOptions, SfxHandle, SongHandle, PlayerEvent, AudioManifest, ManifestSfx, ManifestSong } from "./types.ts";
export { createEngineNode, type EngineNode } from "./engine-node.ts";  // the AudioWorklet wrapper, used by the studio directly
```

See section 5 (worklet protocol) and section 7 (manifest) for the shapes. `@bleepkit/player/worklet` resolves to `src/worklet/processor.ts`.

### 1.5 Internal module map of @bleepkit/core

```
src/types.ts              the contract (section 2.2, verbatim)
src/index.ts  src/tools.ts
src/prng.ts               mulberry32, hashString, deriveSeed
src/version.ts            ENGINE_VERSION
src/notes.ts              note names and frequencies
src/normalize/            issues.ts (Issue, Normalized, helpers), project.ts, sfx.ts, instrument.ts, song.ts, effects.ts (fx string <-> typed), index.ts
src/mml/                  lexer.ts, parser.ts, format.ts, index.ts
src/chips/                nes.ts, gameboy.ts, c64.ts, genesis.ts, adlib.ts, snes.ts, custom.ts, index.ts
src/dsp/                  tables.ts (sine, exp), osc.ts, noise.ts, envelope.ts, macro.ts, fm.ts, sid-filter.ts, svf.ts, echo.ts, reverb.ts, color.ts, limiter.ts, resampler.ts
src/samples/              one file per generator plus index.ts
src/engine/               voice.ts, channel.ts, sequencer.ts, timeline.ts, sfx-compile.ts, synth.ts, render.ts, events.ts, scope.ts
src/tools/                wav.ts, encode.ts, analysis.ts, spectrum.ts, pitch.ts, png.ts, images.ts, buffers.ts, format.ts
```

## 2. Documents

Five JSON documents live in a project folder:

```
<project>/                 by default a folder named audio/ inside the game repo
  project.json             Project
  sfx/<id>.json            Sfx
  instruments/<id>.json    Instrument
  songs/<id>.json          Song
  out/                     renders written by the CLI and the studio (gitignored by init)
    sfx/<id>.wav           masters
    songs/<id>.wav
    songs/<id>.events.json
    analysis/<id>.*.png
```

A document's `id` is its file name without `.json`: lowercase letters, digits and dashes, `^[a-z0-9][a-z0-9-]{0,63}$`. The `id` is not stored inside the file (the CLI and studio fill `id` in memory from the file name when they load; `normalize*` leaves `id` as given or absent). `name` is the human label and may be anything.

Every document has `version: 1`. `FORMAT_VERSION` is `1`. normalize accepts a missing version as 1 (with a warning) and rejects a version greater than `FORMAT_VERSION` with an error. Migrations live in `normalize/migrate.ts` as `migrate(doc, fromVersion): doc` and run before validation; today it is the identity.

### 2.1 The normalize contract

```ts
export interface Issue { severity: "error" | "warning"; path: string; message: string }
export interface Normalized<T> { ok: boolean; value: T; issues: Issue[] }
```

- `path` is a JSON Pointer (RFC 6901): `""` for the root, `/envelope/attack`, `/patterns/intro/tracks/pulse1/3/fx/0`.
- `value` is always a complete, valid document, whatever came in. Unknown fields are dropped (warning). Missing fields get defaults (silent, except when a required field is missing: `error`). Out of range numbers are clamped (warning, with the value that came in). Wrong types are replaced by the default (error). A non-object input yields the default document and one error at `""`.
- `ok` is `issues.every(i => i.severity !== "error")`. Callers must refuse to save or render when `ok` is false; warnings never block.
- normalize is pure and deterministic, and returns a fresh object (never the input).
- `normalizeSong` with an `instruments` map also checks that every instrument the song references exists and has a kind the channel accepts (error at `/channels/<i>/instrument` or `/patterns/<p>/tracks/<ch>/<r>/inst`). Without the map it only checks ids are well formed.
- Message style: imperative, says the rule and the offending value: `must be 0 to 1 (was 3)`, `unknown field "foo" was dropped`, `instrument "lead" is kind "fm" but channel "pulse1" is "pulse"`.

### 2.2 packages/core/src/types.ts (verbatim)

Engineer A creates this file first with exactly this content. Other engineers import from it on day one. Changes to it go through the orchestrator and this document.

```ts
/* @bleepkit/core types: the contract between every package. Documents are plain JSON validated by normalize*; the
   engine, the CLI, the studio and the player all read the normalized shapes below. Units: seconds, Hz, MIDI note
   numbers (69 = A-4 = 440 Hz), cents, levels 0 to 1, pan -1 to 1, unless a field says otherwise. */

export const FORMAT_VERSION = 1;

/* ---------- chips ---------- */

/** "snes" is the 16-bit sample profile (SNES and Amiga style). */
export const CHIP_IDS = ["nes", "gameboy", "c64", "genesis", "adlib", "snes", "custom"] as const;
export type ChipId = (typeof CHIP_IDS)[number];

export const CHANNEL_KINDS = ["pulse", "triangle", "noise", "wave", "sid", "fm", "sample"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** One hardware channel of a chip profile (or a channel the song declares, for "custom"). */
export interface ChipChannel {
  id: string;
  kind: ChannelKind;
  label: string;
  /** Operators per FM voice: 2 (OPL2) or 4 (YM2612). */
  fmOps?: 2 | 4;
  /** For "pulse" on a PSG: duty is fixed at 0.5. */
  fixedDuty?: number;
}

export type PanMode = "none" | "hard" | "free";

/** How a profile keeps sound authentic. The engine applies these at voice level; normalize only warns. */
export interface ChipConstraints {
  /** Allowed pulse duty cycles; empty means any. */
  dutyCycles: readonly number[];
  /** Volume steps per channel (16 = 4-bit); 0 means continuous. */
  volumeSteps: number;
  /** "period": pitch snaps to integer period registers of clockHz; "free": exact. */
  pitch: "period" | "free";
  clockHz: number;
  /** Triangle steps (NES: 16 levels, 32 steps per cycle); 0 means a clean triangle. */
  triangleSteps: number;
  /** Wavetable channel: length and bit depth. */
  waveTable: { length: number; bits: number } | null;
  /** Noise generator model. */
  noise: "lfsr15" | "lfsr7-15" | "lfsr23" | "white";
  /** SID style filter available. */
  filter: boolean;
  pan: PanMode;
  /** Master effects (echo, reverb) available. */
  masterFx: boolean;
}

/** Output coloring applied per chip after mixing its channels. null disables a stage. */
export interface OutputColor {
  /** Sample and hold at this rate before the host rate. */
  sampleRate: number | null;
  /** Quantize to this many bits. */
  bits: number | null;
  /** DAC curve: "linear", "nes" (non-linear pulse/tnd mix), "sid" (slight asymmetry), "ym" (ladder steps). */
  dac: "linear" | "nes" | "sid" | "ym";
  /** One-pole filters on the chip output. */
  lowpassHz: number | null;
  highpassHz: number | null;
  /** Gaussian-like interpolation blur (SNES). */
  gaussian: boolean;
}

export interface ChipProfile {
  id: ChipId;
  label: string;
  channels: readonly ChipChannel[];
  constraints: ChipConstraints;
  color: OutputColor;
  /** Which instrument kinds this chip can host, for the studio's instrument picker and for sfx wave choices. */
  kinds: readonly ChannelKind[];
  /** FM waveform select (OPL) allowed. */
  fmWaveforms: boolean;
  /** Which chip sample generators run at (SNES 32000); null for the host rate. */
  sampleRate: number | null;
}

/* ---------- shared pieces ---------- */

/** ADSR. Times in seconds, sustain is a level. */
export interface Envelope {
  attack: number;   // 0..4, default 0.005
  decay: number;    // 0..4, default 0.1
  sustain: number;  // 0..1, default 0.7
  release: number;  // 0..8, default 0.05
}

/** A per-tick table (one value per engine tick, 60 Hz by default), Famitracker style. */
export interface Macro {
  values: number[];           // 1..256 entries
  /** Index the sequence jumps back to after its last value; -1 holds the last value. */
  loop: number;               // default -1
  /** Index the sequence jumps to on note release; -1 for none. */
  release: number;            // default -1
}

export interface Macros {
  /** 0..1 multiplier on the envelope. */
  volume?: Macro;
  /** Semitone offsets (mode "offset") or absolute notes (mode "fixed"). */
  arpeggio?: Macro;
  arpeggioMode?: "offset" | "fixed";
  /** Cents added per tick (accumulates). */
  pitch?: Macro;
  /** Index into the chip's duty list (pulse), wave index (wave), waveform mask (sid). */
  duty?: Macro;
  /** Pan -1..1 per tick, where the chip allows. */
  pan?: Macro;
}

/* ---------- Project ---------- */

export type SfxFormat = "wav" | "ogg" | "mp3";
export type MusicFormat = "wav" | "ogg" | "mp3";

export interface ProjectExport {
  /** Folder the game loads audio from, relative to the project folder. */
  dir: string;                  // default "../public/audio"
  /** Path of the generated TypeScript manifest, relative to the project folder. */
  manifest: string;             // default "../src/audio.ts"
  /** URL prefix the game fetches files from (manifest base). */
  baseUrl: string;              // default "/audio/"
  sfxFormat: SfxFormat;         // default "ogg"
  musicFormat: MusicFormat;     // default "ogg"
  oggQuality: number;           // -1..10, default 6
  mp3Bitrate: number;           // 64..320, default 160
  /** Also write <song>.events.json next to each song for visuals in file mode. */
  events: boolean;              // default true
  /** Embed the JSON documents in the manifest so the player can synthesize instead of loading files. */
  embed: boolean;               // default false
}

export interface Project {
  version: number;
  name: string;
  /** Default chip for new documents. */
  chip: ChipId;                 // default "nes"
  /** Render sample rate. */
  sampleRate: 44100 | 48000;    // default 48000
  seed: number;                 // default 1, root seed for "new" and "mutate"
  master: {
    volume: number;             // 0..1, default 0.8
    limiter: boolean;           // default true
  };
  export: ProjectExport;
}

/* ---------- Sfx ---------- */

export const SFX_CATEGORIES = [
  "coin", "laser", "explosion", "powerup", "hit", "jump", "blip",
  "door", "alarm", "teleport", "step", "zap", "custom",
] as const;
export type SfxCategory = (typeof SFX_CATEGORIES)[number];

export const SFX_WAVES = ["square", "triangle", "saw", "sine", "noise", "wave", "fm"] as const;
export type SfxWave = (typeof SFX_WAVES)[number];

/** sfxr-style one shot. Rendered through the same engine as instruments (section 3.9). */
export interface Sfx {
  version: number;
  name: string;
  category: SfxCategory;
  chip: ChipId;
  /** Seed the document was generated from; informational, mutate derives from it. */
  seed: number;
  wave: SfxWave;
  volume: number;               // 0..1, default 0.7
  frequency: {
    start: number;              // Hz, 20..8000, default 440
    /** Stop the sound when the pitch slides below this. 0 disables. */
    min: number;                // Hz, 0..8000, default 0
    /** Octaves per second. */
    slide: number;              // -8..8, default 0
    /** Octaves per second per second. */
    deltaSlide: number;         // -16..16, default 0
  };
  vibrato: { depth: number /* semitones 0..2 */; rate: number /* Hz 0..40 */ };
  arpeggio: {
    /** Semitone steps cycled at rate; empty disables. */
    steps: number[];            // each -24..24, up to 8
    rate: number;               // Hz, 0..60, default 0
  };
  envelope: {
    attack: number;             // s, 0..2, default 0
    sustain: number;            // s, 0..3, default 0.1
    /** Extra level at the start of sustain that decays to the sustain level, 0..1. */
    punch: number;              // default 0
    decay: number;              // s, 0..3, default 0.2
  };
  duty: {
    start: number;              // 0..1, default 0.5 (pulse only)
    /** Change per second. */
    sweep: number;              // -4..4, default 0
  };
  /** Retrigger the envelope and frequency every 1/rate seconds; 0 disables. */
  repeat: { rate: number };     // Hz, 0..60
  /** Flanger-like comb (sfxr "phaser"). offset in ms, sweep in ms per second. */
  phaser: { offset: number /* -20..20 */; sweep: number /* -40..40 */ };
  filter: {
    lowpass: number | null;     // Hz 50..20000 or null (off)
    lowpassSweep: number;       // octaves per second, -8..8
    resonance: number;          // 0..1
    highpass: number | null;    // Hz 20..10000 or null
    highpassSweep: number;      // octaves per second, -8..8
  };
  bitcrush: {
    bits: number | null;        // 1..16 or null
    rateDivide: number;         // 1..64, default 1
  };
  noise: { mode: "long" | "short" };
  /** For wave "fm": a 2-op patch; for wave "wave": a 32-step table 0..15. */
  fm: { ratio: number /* 0.5..12 */; index: number /* 0..8 */; indexDecay: number /* s 0..2 */ } | null;
  table: number[] | null;
}

/* ---------- Instrument ---------- */

export interface FmOperator {
  mult: number;         // 0..15 (0 = 0.5)
  detune: number;       // -3..3
  level: number;        // 0..1 linear amplitude (1 = loudest, 0.5 = -6 dB; modulators use it as modulation depth)
  attack: number;       // 0..31 rate
  decay: number;        // 0..31 rate
  sustainLevel: number; // 0..1 linear amplitude the decay stops at (0.5 = -6 dB, 0 = -48 dB)
  sustainRate: number;  // 0..31 (second decay)
  release: number;      // 0..15 rate
  keyScale: number;     // 0..3
  waveform: number;     // 0..7, OPL style; 0 = sine, ignored when the chip has no waveform select
  fixedHz: number | null; // fixed frequency instead of a ratio
}

export interface FmPatch {
  /** 0..7 for 4 op (YM2612 numbering), 0..1 for 2 op (0 = FM, 1 = additive). */
  algorithm: number;
  feedback: number;     // 0..7, on operator 1
  ops: FmOperator[];    // 2 or 4 entries
  lfo: { rate: number /* Hz 0..20 */; pitchDepth: number /* cents 0..100 */; ampDepth: number /* 0..1 */ } | null;
}

export const SAMPLE_GENERATOR_IDS = [
  "kick", "snare", "hat", "tom", "clap", "crash",
  "pluck", "bass", "pad", "organ", "bell", "strings", "choir", "lead",
] as const;
export type SampleGeneratorId = (typeof SAMPLE_GENERATOR_IDS)[number];

export interface SamplePatch {
  generator: SampleGeneratorId;
  /** Generator parameters; unknown keys dropped, known keys clamped to the generator's spec. */
  params: Record<string, number>;
  seed: number;
  /** MIDI note the generated sample plays at unity. */
  baseNote: number;     // default 60
  loop: boolean;        // default false; generators that can loop expose loopStart/loopEnd in GeneratedSample
}

export interface SidPatch {
  waveforms: ("tri" | "saw" | "pulse" | "noise")[];  // 1..4, combined like the SID (AND-ish)
  pulseWidth: number;   // 0..1
  pwmRate: number;      // Hz 0..20
  pwmDepth: number;     // 0..1
  ring: boolean;
  sync: boolean;
  filter: {
    mode: "off" | "lp" | "bp" | "hp";
    cutoff: number;     // 0..1 (maps 30 Hz..12 kHz log)
    resonance: number;  // 0..1
    /** Cutoff added per tick (0..1 units), accumulates; a sweep. */
    sweep: number;      // -0.05..0.05
  };
}

export interface Instrument {
  version: number;
  name: string;
  kind: ChannelKind;
  /** The chip this instrument was designed for; null means any chip with this kind. */
  chip: ChipId | null;
  volume: number;       // 0..1, default 0.8
  pan: number;          // -1..1, default 0
  /** Coarse and fine tuning. */
  transpose: number;    // semitones -48..48
  finetune: number;     // cents -100..100
  envelope: Envelope;
  macros: Macros;
  /** Send levels into the song's master effects (chips with masterFx). */
  send: { echo: number; reverb: number };  // 0..1
  pulse: { duty: number } | null;          // 0..1
  wave: { table: number[] } | null;        // 32 values 0..15
  noise: { mode: "long" | "short" } | null;
  sid: SidPatch | null;
  fm: FmPatch | null;
  sample: SamplePatch | null;
}

/* ---------- Song ---------- */

export type NoteValue = number | "off" | "release";

export const EFFECT_TYPES = [
  "arp", "slideUp", "slideDown", "portamento", "vibrato", "tremolo", "volSlide",
  "jump", "halt", "skip", "tempo", "duty", "pitch", "cut", "delay",
  "noteSlideUp", "noteSlideDown", "pan", "send", "retrigger",
] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];

/** A typed tracker effect. The string form ("A0F") is accepted in JSON and normalized to this. */
export interface Effect {
  type: EffectType;
  /** Two nibbles x, y (0..15) or one byte xx (0..255), per section 2.6. */
  x: number;
  y: number;
}

export interface Row {
  /** Row index inside the pattern, 0-based. */
  row: number;
  note: NoteValue | null;
  /** Instrument id; null keeps the channel's current instrument. */
  inst: string | null;
  /** 0..15; null keeps the current volume. */
  vol: number | null;
  fx: Effect[];                 // up to 4
}

export interface Pattern {
  /** Rows in this pattern. */
  length: number;               // 1..256, default 64
  /** Sparse rows per channel id, sorted by row. */
  tracks: Record<string, Row[]>;
}

export interface SongChannel {
  /** Channel id: must be one of the chip's channel ids, or any id for "custom". */
  id: string;
  /** Required for "custom"; filled from the profile otherwise. */
  kind: ChannelKind;
  /** Instrument used until a row sets one. */
  instrument: string | null;
  volume: number;               // 0..1, default 1
  pan: number;                  // -1..1, default 0
  /** MML for this channel. When set, the pattern tracks for this channel are ignored (warning if both exist). */
  mml: string | null;
  muted: boolean;               // default false
}

export interface SongMaster {
  volume: number;               // 0..1, default 0.8
  echo: { delay: number /* s 0.01..1 */; feedback: number /* 0..0.95 */; level: number /* 0..1 */; lowpassHz: number } | null;
  reverb: { size: number /* 0..1 */; damping: number /* 0..1 */; level: number /* 0..1 */ } | null;
}

export interface Song {
  version: number;
  name: string;
  chip: ChipId;
  /** Beats per minute (quarter notes). */
  tempo: number;                // 20..400, default 120
  /** Rows per quarter note. */
  rowsPerBeat: number;          // 1..16, default 4
  /** Engine tick rate for macros and effects. */
  tickRate: 50 | 60;            // default 60
  channels: SongChannel[];
  patterns: Record<string, Pattern>;
  /** Pattern ids in play order. */
  order: string[];              // 1..256 entries
  /** Order index the song loops back to after the last pattern; null means play once. */
  loop: number | null;          // default 0
  master: SongMaster;
}

/* ---------- MML ---------- */

export interface MmlOptions {
  /** Default octave (4), default length (8), default volume (15). */
  octave?: number;
  length?: number;
  volume?: number;
}

export type MmlEvent =
  | { type: "note"; pulse: number; duration: number; gate: number; note: number; volume: number; inst: string | null; fx: Effect[] }
  | { type: "rest"; pulse: number; duration: number }
  | { type: "volume"; pulse: number; value: number }
  | { type: "inst"; pulse: number; id: string }
  | { type: "pan"; pulse: number; value: number }
  | { type: "loop"; pulse: number };

/** Pulses per quarter note on the internal timeline. */
export const PPQ = 96;

/* ---------- engine ---------- */

export interface SynthOptions {
  sampleRate: number;           // 22050..96000
  /** Polyphony for sfx voices, default 8. */
  sfxVoices?: number;
  /** Scope ring size in frames, default SCOPE_FRAMES (2048). */
  scopeFrames?: number;
  /** Optional shared memory for scopes (section 5.3). */
  scopeBuffer?: SharedArrayBuffer | null;
}

export type EngineEventType = "noteOn" | "noteOff" | "trigger" | "row" | "loop" | "end";

/** What the engine emits for visuals. frame is the engine's running sample clock. */
export interface EngineEvent {
  type: EngineEventType;
  frame: number;
  /** Channel index into chipChannels(song) for song voices; sfx voices use -1. */
  channel: number;
  channelId: string;
  /** MIDI note (fractional allowed) and velocity 0..1 for noteOn; 0 otherwise. */
  note: number;
  hz: number;
  velocity: number;
  /** Instrument id for noteOn, sfx id for trigger, pattern id for row. */
  id: string;
  /** Order index and row for "row"; -1 otherwise. */
  order: number;
  row: number;
}

export interface SongPosition { order: number; row: number; tick: number; pulse: number }

export interface RenderOptions {
  sampleRate?: number;          // default 48000
  /** Seed for anything random in the render (noise phase, sample generators without their own seed). */
  seed?: number;                // default 1
  /** Song: passes through the loop section after the first one; default 1. A looping song always renders two passes
      (the second is the one a game repeats, so `loopStart` and `loopEnd` bracket it), and 3 adds two more. */
  loops?: number;
  /** The project's master. Sfx renders apply `volume` (default 0.8 when absent); songs keep their own
      `song.master.volume`. `limiter: false` bypasses the output limiter for both (default: on). */
  master?: { volume: number; limiter: boolean };
  /** Song: seconds of release tail after the end; default 1 (0.25 for sfx). */
  tail?: number;
  /** Also return per-channel dry stems (before master effects). */
  stems?: boolean;
  /** Progress callback every 2^16 frames; return false to abort. */
  onProgress?: (frames: number, total: number) => boolean | undefined;
}

export interface RenderResult {
  sampleRate: number;
  /** Stereo: [left, right], equal length. */
  channels: Float32Array[];
  frames: number;
  events: EngineEvent[];
  /** Loop points in frames, when the source loops: the start and end of the second pass through the loop section. */
  loopStart?: number;
  loopEnd?: number;
  /** Per-channel mono stems, when requested. */
  stems?: Float32Array[];
  stemIds?: string[];
}

export interface GeneratedSample {
  data: Float32Array;
  sampleRate: number;
  baseNote: number;
  loopStart: number | null;
  loopEnd: number | null;
}

export interface SampleParamSpec { label: string; min: number; max: number; default: number }
export interface SampleGeneratorSpec {
  id: SampleGeneratorId;
  label: string;
  params: Record<string, SampleParamSpec>;
  loops: boolean;
}

export const SCOPE_FRAMES = 2048;

/** Scope rings the synth writes every block. Layout in shared memory when scopeBuffer is given (section 5.3):
    [head: u32][channels * frames: f32][master L: frames f32][master R: frames f32]. */
export interface ScopeRings {
  readonly frames: number;
  readonly channels: Float32Array[];
  readonly master: [Float32Array, Float32Array];
  /** Frames written so far modulo frames, in a Uint32Array(1) so it can live in shared memory. */
  readonly head: Uint32Array;
}

/** Reads scope rings into reused output buffers. channel -1 and -2 are master L and R. */
export interface ScopeReader {
  latest(channel: number, frames: number): Float32Array;
  at(channel: number, frame: number, frames: number): Float32Array;
}

/** The realtime engine (section 4.1). Everything that allocates is a load* or set* method; process never allocates. */
export interface Synth {
  readonly sampleRate: number;
  /** Running frame counter, starts at 0, never resets. */
  readonly frame: number;
  readonly playing: boolean;
  readonly scopes: ScopeRings;
  loadSong(song: Song, instruments: Record<string, Instrument>): void;
  unloadSong(): void;
  loadSfx(id: string, sfx: Sfx): void;
  unloadSfx(id: string): void;
  setInstrument(id: string, inst: Instrument): void;
  play(opts?: { order?: number; row?: number; loop?: boolean }): void;
  stop(): void;
  pause(): void;
  seek(order: number, row: number): void;
  /** Returns a voice handle >= 1, or 0 when no voice could be taken. */
  trigger(id: string, opts?: { velocity?: number; pan?: number; pitch?: number; seed?: number }): number;
  release(handle: number): void;
  noteOn(channel: number, note: number, velocity: number, instrument?: string): void;
  noteOff(channel: number): void;
  setChannel(channel: number, opts: { muted?: boolean; solo?: boolean; volume?: number; pan?: number }): void;
  setMaster(opts: { volume?: number; limiter?: boolean }): void;
  setTempo(tempo: number): void;
  setScopeBuffer(buffer: SharedArrayBuffer | null): void;
  position(): SongPosition | null;
  channels(): readonly ChipChannel[];
  /** Fill left and right with the next frames (<= 128). Events emitted during the block are appended to out. */
  process(left: Float32Array, right: Float32Array, frames: number, out: EngineEvent[]): void;
}

/* ---------- normalize ---------- */

export interface Issue { severity: "error" | "warning"; path: string; message: string }
export interface Normalized<T> { ok: boolean; value: T; issues: Issue[] }

/* ---------- worklet protocol (section 5) ---------- */

export type ToWorklet =
  | { type: "loadSong"; song: Song; instruments: Record<string, Instrument> }
  | { type: "unloadSong" }
  | { type: "loadSfx"; id: string; sfx: Sfx }
  | { type: "unloadSfx"; id: string }
  | { type: "play"; order?: number; row?: number; loop?: boolean }
  | { type: "stop" }
  | { type: "pause" }
  | { type: "seek"; order: number; row: number }
  | { type: "trigger"; id: string; velocity?: number; pan?: number; pitch?: number; seed?: number; handle: number }
  | { type: "release"; handle: number }
  | { type: "noteOn"; channel: number; note: number; velocity: number; instrument?: string }
  | { type: "noteOff"; channel: number }
  | { type: "setInstrument"; id: string; instrument: Instrument }
  | { type: "setChannel"; channel: number; muted?: boolean; solo?: boolean; volume?: number; pan?: number }
  | { type: "setMaster"; volume?: number; limiter?: boolean }
  | { type: "setTempo"; tempo: number }
  | { type: "setScopeBuffer"; buffer: SharedArrayBuffer | null };

export type FromWorklet =
  | { type: "ready"; sampleRate: number }
  | { type: "events"; clockFrame: number; clockTime: number; events: EngineEvent[] }
  | { type: "clock"; frame: number; time: number; position: SongPosition | null; playing: boolean }
  | { type: "scope"; frame: number; buffers: Float32Array[]; master: Float32Array[] }
  | { type: "ended" }
  | { type: "error"; message: string };

/* ---------- manifest (section 7) ---------- */

export interface ManifestSfx { file: string; duration: number; data?: Sfx }
export interface ManifestSong {
  file: string;
  duration: number;
  loopStart: number | null;     // seconds
  loopEnd: number | null;
  events?: string;              // path of the events json
  data?: { song: Song; instruments: Record<string, Instrument> };
}
export interface AudioManifest {
  base: string;
  sampleRate: number;
  sfx: Record<string, ManifestSfx>;
  songs: Record<string, ManifestSong>;
}
```

### 2.3 Project: defaults and example

`project.json` is small on purpose: the folder is the project, the file holds settings. Example:

```json
{
  "version": 1,
  "name": "Deep Reach",
  "chip": "genesis",
  "sampleRate": 48000,
  "seed": 7,
  "master": { "volume": 0.8, "limiter": true },
  "export": {
    "dir": "../public/audio",
    "manifest": "../src/audio.ts",
    "baseUrl": "/audio/",
    "sfxFormat": "ogg",
    "musicFormat": "ogg",
    "oggQuality": 6,
    "mp3Bitrate": 160,
    "events": true,
    "embed": false
  }
}
```

### 2.4 Sfx: semantics and example

The Sfx fields follow sfxr so that anyone who has used sfxr, jsfxr or bfxr can read them, but every value is in a physical unit. Rules normalize enforces:

- `wave` must be one the chip allows: nes `square | triangle | noise`; gameboy `square | wave | noise`; c64 `square | saw | triangle | noise`; genesis `square | noise | fm`; adlib `fm | square | sine | saw`; snes `sine | triangle | saw | square | noise`; custom all. A disallowed wave is replaced by the chip's first allowed wave (error).
- `duty.start` is snapped to the chip's duty list at render time, not by normalize (warning only), so a document moved between chips keeps its intent.
- `frequency.min > frequency.start` with `slide >= 0` is a warning (the sound stops immediately).
- Total duration = attack + sustain + decay, capped at 10 s (error above).
- `table` must have exactly 32 integers 0..15 when `wave` is `wave`; `fm` must be set when `wave` is `fm`; otherwise they are nulled (warning).

Example, `sfx/coin.json`:

```json
{
  "version": 1,
  "name": "Coin",
  "category": "coin",
  "chip": "nes",
  "seed": 1234,
  "wave": "square",
  "volume": 0.6,
  "frequency": { "start": 1046.5, "min": 0, "slide": 0, "deltaSlide": 0 },
  "vibrato": { "depth": 0, "rate": 0 },
  "arpeggio": { "steps": [7], "rate": 14 },
  "envelope": { "attack": 0, "sustain": 0.06, "punch": 0.4, "decay": 0.25 },
  "duty": { "start": 0.5, "sweep": 0 },
  "repeat": { "rate": 0 },
  "phaser": { "offset": 0, "sweep": 0 },
  "filter": { "lowpass": null, "lowpassSweep": 0, "resonance": 0, "highpass": null, "highpassSweep": 0 },
  "bitcrush": { "bits": null, "rateDivide": 1 },
  "noise": { "mode": "long" },
  "fm": null,
  "table": null
}
```

### 2.5 Instrument: semantics and example

- `kind` picks which patch block must be non-null: `pulse` -> `pulse`, `wave` -> `wave`, `noise` -> `noise`, `sid` -> `sid`, `fm` -> `fm`, `sample` -> `sample`, `triangle` -> none. The other blocks are nulled (warning if they held data).
- `fm.ops.length` must be 2 or 4. When `chip` is set it must match the chip's `fmOps` (error); when `chip` is null the song's chip decides at compile time and a 4-op patch on a 2-op chip uses operators 0 and 1 with algorithm `min(algorithm, 1)` (warning from `normalizeSong`).
- `macros.*.values` lengths 1..256; `loop` and `release` must be inside the array or -1.
- For `triangle` the envelope and volume macro act as a gate: level above 0.5 is on, else off (NES triangle has no volume). Documented in the studio inspector too.
- `send` is ignored unless the chip has `masterFx`.

Example, `instruments/lead.json` (NES pulse lead with a Famitracker-style volume and arp macro):

```json
{
  "version": 1,
  "name": "Lead",
  "kind": "pulse",
  "chip": "nes",
  "volume": 0.8,
  "pan": 0,
  "transpose": 0,
  "finetune": 0,
  "envelope": { "attack": 0, "decay": 0.15, "sustain": 0.6, "release": 0.04 },
  "macros": {
    "volume": { "values": [1, 1, 0.9, 0.8, 0.75, 0.7, 0.65, 0.6], "loop": -1, "release": -1 },
    "arpeggio": { "values": [0, 0, 12, 0], "loop": 0, "release": -1 },
    "arpeggioMode": "offset",
    "duty": { "values": [2, 2, 1, 1, 0], "loop": 3, "release": -1 }
  },
  "send": { "echo": 0, "reverb": 0 },
  "pulse": { "duty": 0.5 },
  "wave": null,
  "noise": null,
  "sid": null,
  "fm": null,
  "sample": null
}
```

A genesis FM instrument sets `kind: "fm"` and `fm: { algorithm: 4, feedback: 3, ops: [ ...4 ops... ], lfo: null }`; a snes instrument sets `kind: "sample"` and `sample: { generator: "pluck", params: { brightness: 0.6, damp: 0.3 }, seed: 3, baseNote: 60, loop: false }`.

### 2.6 Song: patterns, rows, effects, example

Timeline unit: the pulse, `PPQ = 96` pulses per quarter note. A row lasts `96 / rowsPerBeat` pulses (24 at the default 4 rows per beat, a sixteenth note). An MML length `n` lasts `384 / n` pulses. Pulses convert to samples with the current tempo: `samplesPerPulse = sampleRate * 60 / (tempo * 96)`. Ticks (`tickRate` Hz) are an independent clock for macros and effects; a row does not need a whole number of ticks.

Rows are sparse: `tracks.<channelId>` is an array of `Row` sorted by `row`, each `row < length`, no duplicates (error). In JSON a row may be written in a compact string form that normalize expands:

```
"C-4 lead 0F A0F V02"      note inst vol fx...   fields separated by spaces, "." or "--" for an empty field
```

Compact grammar per row string: `<note> [<inst>] [<vol>] [<fx>...]` where `<note>` is `C-4`, `C#4`, `Db4`, `n60`, `OFF`, `REL`, or `...`; `<inst>` is an id or `.`; `<vol>` is one hex digit prefixed by `v` (`v0`..`vF`) or `.`; `<fx>` is a tracker code. Normalize accepts either `Row` objects or `{ row, s: "C-4 lead vF A0F" }` and always outputs full `Row` objects.

Effect codes (string form `<letter><xx>` with two hex digits; typed form `{ type, x, y }` where `x` and `y` are the two nibbles and `xx = x * 16 + y`):

| code | type | meaning (per tick unless said) |
| --- | --- | --- |
| `0xy` | arp | cycle base, +x, +y semitones, one step per tick; `000` stops |
| `1xx` | slideUp | pitch up xx sixteenths of a semitone per tick |
| `2xx` | slideDown | pitch down xx sixteenths of a semitone per tick |
| `3xx` | portamento | slide toward each new note at xx sixteenths per tick; `300` disables |
| `4xy` | vibrato | speed x (table: ticks per cycle 64/x, 0 = off), depth y * 8 cents |
| `7xy` | tremolo | speed x, depth y / 15 of volume |
| `Axy` | volSlide | volume +x -y sixteenths per tick (one of x, y is 0) |
| `Bxx` | jump | after this row, continue at order index xx |
| `Cxx` | halt | stop the song after this row (xx ignored) |
| `Dxx` | skip | after this row, continue at row xx of the next order entry |
| `Fxx` | tempo | set tempo to xx BPM (xx is hex in the string form, 0x20..0xFF) |
| `Vxx` | duty | pulse duty index, wave index, sid waveform mask, fm algorithm |
| `Pxx` | pitch | fine pitch offset (xx - 0x80) sixteenths of a semitone, applied at once |
| `Sxx` | cut | note off after xx ticks |
| `Gxx` | delay | trigger this row's note xx ticks late |
| `Qxy` | noteSlideUp | slide up y semitones at speed x (x * 2 sixteenths per tick) |
| `Rxy` | noteSlideDown | slide down y semitones at speed x |
| `Xxx` | pan | 0x00 left, 0x80 center, 0xFF right (snapped per chip pan mode) |
| `Wxx` | send | echo send level xx / 255 (chips with masterFx) |
| `Hxx` | retrigger | retrigger the note every xx ticks until the next row with a note |

Persistent effects (arp, vibrato, tremolo, volSlide, slides, portamento, retrigger) stay on until the same letter appears with `00`. Continuous effects on a channel stop at a `note off`. The typed form is canonical; `formatEffect(e)` produces the string for the studio and for `patternToMml`.

Example, `songs/title.json` (two patterns, MML on the noise channel, a loop to order 1):

```json
{
  "version": 1,
  "name": "Title",
  "chip": "nes",
  "tempo": 150,
  "rowsPerBeat": 4,
  "tickRate": 60,
  "channels": [
    { "id": "pulse1", "kind": "pulse", "instrument": "lead", "volume": 1, "pan": 0, "mml": null, "muted": false },
    { "id": "pulse2", "kind": "pulse", "instrument": "lead", "volume": 0.8, "pan": 0, "mml": null, "muted": false },
    { "id": "triangle", "kind": "triangle", "instrument": "bass", "volume": 1, "pan": 0, "mml": null, "muted": false },
    { "id": "noise", "kind": "noise", "instrument": "drums", "volume": 0.7, "pan": 0,
      "mml": "l8 @drums o3 [c r d r c c d r]4 L [c r d r c c d d]8", "muted": false }
  ],
  "patterns": {
    "intro": {
      "length": 32,
      "tracks": {
        "pulse1": [
          { "row": 0, "note": 72, "inst": "lead", "vol": 15, "fx": [] },
          { "row": 4, "s": "E-5 . . 047" },
          { "row": 8, "s": "G-5 . vC" },
          { "row": 14, "s": "OFF" }
        ],
        "triangle": [
          { "row": 0, "s": "C-2 bass" },
          { "row": 16, "s": "G-1" }
        ]
      }
    },
    "verse": {
      "length": 64,
      "tracks": {
        "pulse1": [ { "row": 0, "s": "C-5 lead vF 037" }, { "row": 32, "s": "A-4 . . 037" } ],
        "pulse2": [ { "row": 2, "s": "C-4 lead vA" }, { "row": 34, "s": "A-3" } ],
        "triangle": [ { "row": 0, "s": "C-2" }, { "row": 16, "s": "F-1" }, { "row": 32, "s": "A-1" }, { "row": 48, "s": "G-1" } ]
      }
    }
  },
  "order": ["intro", "verse", "verse"],
  "loop": 1,
  "master": { "volume": 0.8, "echo": null, "reverb": null }
}
```

Validation rules beyond types: every `order` entry names an existing pattern; `loop` < `order.length`; channel ids unique and (for a fixed chip) a subset of the profile's channel ids in any order; a pattern track key must be a channel id (unknown keys dropped with a warning); `jump` targets inside `order`.

### 2.7 MML form

One string per channel (`SongChannel.mml`). It compiles to the same timeline as patterns. Grammar (whitespace ignored, case sensitive, `;` comments to end of line):

```
note      c d e f g a b, optionally + or # (sharp) or - (flat), optional length (1 2 4 8 16 32 64, optional dots), & ties to the next note
n<midi>   note by MIDI number, optional length
r         rest, optional length
o<0-8>    octave (default 4)    >  octave up    <  octave down
l<n>      default length (default 8)
v<0-15>   volume (default 15)
p<0-15>   pan (0 left, 8 center, 15 right)
@<id>     instrument by id (letters, digits, dashes), ends at a non-id character
q<1-8>    gate: notes sound for q/8 of their length (default 8)
k<n>      transpose in semitones, signed (k-12)
t<n>      tempo; sets song.tempo when the song has no patterns, otherwise a warning if it differs
w<n>      duty index (shorthand for {V0n})
{Axx}     attach a tracker effect to the next note (several braces allowed)
[ ... ]<n>  repeat n times (default 2), nesting up to 4
L         loop point: the song loops back here (one channel is enough; the first L wins)
|         bar line, ignored
```

Rules: a note's `duration` is `384 / length` pulses (dots multiply by 1.5, 1.75, ...); `gate` is `duration * q / 8`, a note off is emitted at `pulse + gate`; a tie `&` joins the next note's duration without a retrigger; `L` in MML sets the song's loop in pulses, which must land on an order boundary when patterns exist (warning and rounding otherwise). `mmlToTrack` rounds events to rows (warning when a note is finer than a row; the engine itself uses exact pulses so playback is not rounded). `parseMml` never throws; errors are issues with the character offset in the message, path `/channels/<i>/mml`.

A song with every channel in MML and no patterns is allowed: `patterns: {}`, `order: []`, and normalize synthesizes one pattern per 4 beats for the studio's tracker view (read only until the user converts it).

## 3. Engine design

### 3.1 Clocks and rates

- Host sample rate: whatever `SynthOptions.sampleRate` says (the AudioContext rate in the browser, 48000 for CLI renders unless `project.sampleRate` says 44100). The engine runs every voice at the host rate; chip coloring resamples down and back where a profile asks for it (section 3.8). Reason: one rate for everything keeps mixing trivial and the worklet never resamples the output.
- Tick clock: `song.tickRate` (60 default, 50 for PAL feel) for macros and tracker effects. Sfx use 60 always. Ticks are scheduled on the sample clock as `tickFrames = sampleRate / tickRate` (fractional, accumulated as a float, never rounded per tick, so 60 Hz stays 60 Hz over a minute).
- Pulse clock: `PPQ = 96` per quarter note at `tempo` BPM for note timing. Tempo changes take effect at the row where they happen.
- Block size: the engine processes in blocks of up to 128 frames (`Synth.process(left, right, frames)` where `frames <= 128`). Inside a block, ticks and events are sample accurate: the block is split at every tick and event boundary (a sub-block loop), so a note on at frame 37 starts at frame 37.

### 3.2 Voices and channels

A `Channel` is a song slot (one per `ChipChannel`) that owns one `Voice` and the sequencer state for that track (current instrument, volume column, active effects, portamento target). A `Voice` is the DSP unit: oscillator or FM stack or sample player, envelope, macros, filter, output gain and pan. Sfx are played on a separate pool of `sfxVoices` (default 8) voices with the same `Voice` class, driven by a compiled sfx program (section 3.9) instead of a channel sequencer.

Voice state is allocated at `createSynth` time for the maximum channel count of any chip (genesis: 6 FM + 4 PSG = 10) plus the sfx pool. Loading a song reconfigures voices in place. No allocation happens in `process`; every per-voice buffer is a preallocated `Float32Array(128)`.

The voice signal path, in order:

```
source (osc | fm | sid | wave | noise | sample)
  -> chip quantization of pitch and duty (constraints)
  -> voice filter (sid SVF, sfx lowpass/highpass with sweep)
  -> sfx-only: phaser comb, bitcrush
  -> amplitude = envelope * macro volume * tremolo * vol column * instrument volume * channel volume, quantized to constraints.volumeSteps
  -> pan (per PanMode) -> channel stem (mono, for scopes and stems) and into the chip mix bus (stereo)
```

### 3.3 Oscillators per chip

| chip | source models |
| --- | --- |
| nes | pulse with duty from `[0.125, 0.25, 0.5, 0.75]`, 16-level stepped triangle (32 steps per cycle, no volume), LFSR noise 15-bit long mode and 7-bit short mode with the NES 16-entry period table scaled to the host rate |
| gameboy | pulse with the same duty list, 32-step 4-bit wave channel (table from the instrument, 4-bit output levels), LFSR noise 15 and 7 bit with the Game Boy divisor table |
| c64 | SID voice: tri, saw, pulse with PWM, noise (23-bit LFSR), waveform combining by AND of the two waveforms' 12-bit outputs, ring mod (tri of voice n multiplied by sign of voice n-1), hard sync (reset phase of voice n when voice n-1 wraps), one shared multimode 12 dB SVF (lp, bp, hp) with resonance 0..1, per-voice filter routing by `sid.filter.mode !== "off"` |
| genesis | 6 x 4-op FM (section 3.5) + PSG: 3 square at duty 0.5 and 1 noise (SN76489: 15-bit LFSR white or periodic; the shift rate is one of the 3 fixed rates, clock / 512, 1024 or 2048, or in tone3 mode clock / (32 N) from the divider of square 3, N = 1..1023). Song notes use the fixed rates. An sfx whose noise pitch moves (slide, vibrato or arpeggio) uses tone3 mode, so its sweeps glide the way they do on hardware instead of jumping between three rates or turning into a tone |
| adlib | 9 x 2-op FM with OPL2 waveform select (0 sine, 1 half sine, 2 abs sine, 3 pulse sine, 4..7 OPL3 extras allowed in custom) |
| snes | 8 sample channels (generated samples, section 3.7), gaussian interpolation, 32000 Hz internal rate, per-voice ADSR in SPC700 rate steps, echo bus with 8-tap FIR lowpass simplified to one pole + feedback |
| custom | any kind on any channel, no constraints, free pan, master effects available |

Pulse oscillators are anti-aliased with PolyBLEP; triangle, saw and wave tables are naive on purpose (aliasing is part of the sound, and the chip's coloring stage adds the real one). The triangle of the NES is a 32-step table (values 15..0..15); all step tables are built once in `dsp/tables.ts`.

Pitch quantization (`constraints.pitch === "period"`): the target Hz converts to an integer period register `round(clockHz / (16 * hz)) - 1` (NES pulse formula; each chip file supplies its own `hzToPeriod` / `periodToHz`), is clamped to the chip's 11-bit (NES) or equivalent range, and converts back. This is what makes high notes on an NES pulse slightly out of tune, which is authentic. The studio shows the detune in cents in the inspector.

Per-chip constraints and coloring (the values `chips/<id>.ts` must export; tests pin them):

| chip | channels | duty | volumeSteps | pitch | noise | filter | pan | masterFx | color |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| nes | pulse1, pulse2 (pulse), triangle, noise | 12.5/25/50/75 | 16 | period, 1789773 Hz | lfsr7-15 | no | none | no | dac nes, lp 14000, hp 37 |
| gameboy | pulse1, pulse2, wave (32 x 4-bit), noise | 12.5/25/50/75 | 16 | period, 4194304 Hz | lfsr7-15 | no | hard | no | dac linear, lp 12000, hp 60 |
| c64 | voice1, voice2, voice3 (sid) | any | 16 (master only, voices continuous) | period, 985248 Hz | lfsr23 | yes | none | no | dac sid, lp 16000 |
| genesis | fm1..fm6 (fm, 4 op), psg1..psg3 (pulse, fixedDuty 0.5), psgNoise (noise) | 50 | 16 (psg), 128 (fm) | period, 3579545 Hz (psg), free (fm) | lfsr15 | no | hard | no | dac ym, lp 18000 |
| adlib | fm1..fm9 (fm, 2 op) | n/a | 64 | free | white (fm noise not modeled) | no | none | no | dac linear, sampleRate 49716 (null, above host), lp 16000 |
| snes | ch1..ch8 (sample) | n/a | 128 | free | white | no | free | yes | sampleRate 32000, bits 16, gaussian, dac linear |
| custom | declared by the song | any | 0 | free | white | yes | free | yes | nothing |

### 3.4 Envelopes and macros

- ADSR in seconds with linear attack, exponential decay and release (coefficient per sample, precomputed when the stage starts). Stepped per `volumeSteps` after the macro multiply, so an NES envelope moves in 16 levels.
- Macros run on the tick clock: each tick advances every present macro by one index, honoring `loop` and `release` (jump to `release` index on note off, then continue to the end). Macro outputs apply for the whole next tick. Arpeggio `offset` adds semitones to the note; `fixed` replaces it (drums on a noise channel). Pitch macro accumulates cents. Duty indexes into the chip's duty list (pulse), selects the wave index within the instrument's table set (we store one table, so values other than 0 are ignored with a normalize warning), or the SID waveform mask bits (1 tri, 2 saw, 4 pulse, 8 noise).
- Tracker effects run on the same tick and modify the same voice fields; the order of application per tick is: macros, then effects (effects win), then quantization.
- FM operators use rate-based envelopes (section 3.5) and ignore the ADSR seconds block, except `release` which converts to a rate when the instrument has no per-operator release.

### 3.5 FM

One operator: phase accumulator at `hz * (mult === 0 ? 0.5 : mult) * detuneFactor` (or `fixedHz`), waveform from the OPL table when the chip allows it, else sine. Modulation input is added to the phase in radians scaled by `MOD_INDEX = 8` (so an operator at level 1 modulates by 8 radians, enough for metallic sounds; tests pin this constant). Output level is `level` read as a linear amplitude and converted to attenuation, `TL = -20 * log10(max(1e-5, level))` dB capped at 48 dB (level 1 is 0 dB, 0.5 is 6 dB, 0.25 is 12 dB, and 0 is the 48 dB floor, not silence), then the operator envelope: attack rate, decay rate to `sustainLevel` (the same mapping, `-20 * log10(max(1e-5, sustainLevel))` capped at 48 dB, so a sustain of 0.25 settles 12 dB under the peak), sustain rate (second decay), release rate, each rate 0..31 mapped to seconds by the YM2612 table approximation `seconds = 10 * 2^(-rate / 2.5)` (rate 31 is near instant, rate 0 never moves). `keyScale` shortens rates at higher notes. Feedback applies to operator 1 (index 0) as `fb = feedback === 0 ? 0 : 2^(feedback - 7) * PI` radians of its own previous two outputs averaged.

4-op algorithms (YM2612 numbering, operators 1..4 are `ops[0..3]`):

```
0: 1>2>3>4          4: (1>2) + (3>4)
1: (1+2)>3>4        5: 1>(2+3+4)
2: (1+(2>3))>4      6: (1>2) + 3 + 4
3: ((1>2)+3)>4      7: 1 + 2 + 3 + 4
```

2-op: `0: 1>2`, `1: 1 + 2`. The LFO (per song, one for the whole chip like real hardware, but we allow per instrument settings and run one LFO per voice for simplicity) adds pitch vibrato in cents and amplitude modulation.

A key on restarts everything that shapes the note: operator phases, the feedback memory, the envelope levels and the voice's LFO pitch offset all reset to zero, so a note sounds the same whatever the voice played before it (the voice hides the resulting step with its short declick when it was still sounding). Without that a looped song's second pass would differ from its first and the loop would click at the seam.

Patches are tuned to be measured, not guessed. A modulator that decays faster than its carrier gives a bright attack that settles into a duller sustain: on the starter bass (genesis) the spectral centroid is about 600 Hz in the first 90 ms and 220 Hz in the sustain, on the fixture bass 560 Hz against 340 Hz, and the lead keeps its second harmonic within 7 dB of the fundamental throughout. `defaultFmPatch` (modulators near 0.3 to 0.5, carriers 0.9 to 1) is the baseline for a new FM instrument; the CLI's per-preset starters (lead, bass, drums, pad, bell) are in `packages/cli/src/presets.ts`.

FM runs at the host rate with a sine table of 4096 entries and linear interpolation; no oversampling. Aliasing at high modulation indexes is accepted as part of the character.

### 3.6 Filters and effects

- SID filter: Chamberlin SVF, cutoff 30 Hz to 12 kHz log mapped from 0..1, resonance 0..1 mapped to Q 0.5..8, shared per chip (c64 has one filter): the synth sums the routed voices into it and adds the unrouted voices after.
- Sfx lowpass/highpass: one-pole-per-stage 12 dB (two cascaded one-poles) with resonance feedback for the lowpass, sweeps in octaves per second.
- Phaser (sfx): sfxr style delayed copy added, offset modulated by sweep, 1024-frame ring.
- Bitcrush: quantize to `bits`, sample and hold every `rateDivide` frames.
- Master effects (chips with `masterFx`, custom and snes): echo (delay line up to 1 s at host rate, feedback, one-pole lowpass in the loop, level) fed by per-instrument sends, then a small reverb (4 comb + 2 allpass, Schroeder, sizes scaled by `size`, damping as a one-pole in each comb). Dry and wet sum into the master bus.

### 3.7 Sample generators (snes profile)

`generateSample(gen, params, seed, sampleRate)` synthesizes a `GeneratedSample` deterministically: drums (kick: sine sweep with click; snare: tone plus filtered noise; hat: metallic noise burst; tom; clap: four noise bursts; crash: long filtered noise), and tonal generators with loop points (pluck: Karplus-Strong; bass: filtered saw; pad: detuned saws with slow filter; organ: additive drawbars; bell: FM 2 op; strings: sawtooth chorus; choir: formant filtered pulses; lead: pulse with vibrato). Samples are generated at `chipProfile.sampleRate ?? host` (32000 for snes), cached by a key of `(gen, params, seed, rate)` inside the synth (a `Map`, filled on `loadSong`, never in `process`). Voice playback uses linear interpolation at the host rate, with the SNES gaussian blur applied in coloring. Max sample length 4 s.

### 3.8 Chip coloring and master

After the chip mix bus (stereo, sum of voices after pan):

1. DAC curve (`color.dac`): `nes` applies the non-linear mixer formula from the NES APU for pulse and tnd groups (the synth keeps the two groups separate on nes for this), `sid` adds a tiny DC and soft asymmetry, `ym` quantizes to 9-bit ladder steps, `linear` nothing.
2. Sample rate reduction (`color.sampleRate`): sample and hold at the stated rate (c64 none; genesis 53267 skipped since above host, so null; snes 32000 with gaussian interpolation; adlib 49716 null; nes null; gameboy null). The two 8-bit chips get their grit from the stepped volumes and DACs rather than rate reduction.
3. Bit depth (`color.bits`): snes 16 (none effectively), others null.
4. Lowpass and highpass one-poles (`lowpassHz`, `highpassHz`): nes lp 14 kHz hp 37 Hz, gameboy lp 12 kHz hp 60 Hz, c64 lp 16 kHz, genesis lp 18 kHz, adlib lp 16 kHz, snes handled by gaussian, custom none.

Pan modes: `none` mixes mono to both sides (nes, gameboy, c64, adlib); `hard` snaps pan to left, center, right (genesis, like the YM2612 L/R bits; gameboy actually has hard L/R bits too, so gameboy is `hard`); `free` is equal power pan (snes, custom).

Leveling: chips are leveled once, in core, by `CHIP_GAIN` in `dsp/color.ts`, so that a full-volume square note peaks at -12 dBFS within 1.5 dB on every chip (a core test renders it on all 7 chips). Nothing downstream adds per-chip compensation except the sfx filter and phaser makeup in `@bleepkit/sfx`. SNES sample drums are normalized to a 0.95 peak (`DRUM_PEAK` in `samples/generators.ts`), so their instrument volume is a plain level like any other.

Master: `song.master.volume` or `project.master.volume` gain, then the limiter when enabled: a lookahead peak limiter (1 ms lookahead, 50 ms release, ceiling -0.3 dBFS) implemented with a 64-frame delay line. The limiter is always the last stage and always in both realtime and offline paths so renders match playback.

### 3.9 Sfx execution

An Sfx document compiles (`sfx-compile.ts`) into a `SfxProgram`: precomputed per-frame coefficients (frequency slide per frame as a multiplier, duty sweep per frame, envelope stage lengths in frames, filter coefficients and sweeps, arpeggio step frames, repeat period in frames, phaser offsets). A Voice runs the program with the same oscillator code as instruments (the `wave` maps to a source: `square` -> pulse, `wave` -> wavetable with the given table, `fm` -> 2-op FM with the 3 parameter patch, `noise` -> the chip's noise model). `RenderOptions.master` (`{ volume, limiter }`) is applied to sfx renders too: the CLI passes the project master and, without one, sfx render at volume 0.8 with the limiter on. Songs keep their own `master`. The 2-op sfx FM path takes the modulation index in radians, like the textbook formula (the control path divides by 2 pi before the operator, where the instrument FM path of 3.5 uses TL in dB), and the sfx builder (`limitFm`) caps the modulator at 6 kHz and the Carson bandwidth at 40 kHz so a laser stays near a 4 kHz centroid. On genesis the PSG noise channel cannot sweep on its own, so moving-pitch noise uses tone3 mode (the noise rate follows channel 3 pitch times 16; `quantizeTone3NoiseRate`), and `CHIP_CAPS.noiseSweep` is false where a sweep is impossible. The chip's constraints and coloring apply exactly as for songs: an nes coin uses stepped 4-bit volume and the period table. For sfx the engine creates a tiny per-sfx chip bus so that a nes coin and a genesis laser fired at the same time each keep their own coloring (sfx pool voices carry their chip id; the synth keeps one coloring state per chip, allocated at create time for all 7 chips).

Pitch-less params a game may vary at trigger time: `velocity` (scales volume), `pitch` (semitone offset to `frequency.start`), `pan`, `seed` (noise phase and any `randomize` left in the program: none today, reserved).

### 3.10 Determinism

- `renderSfx` and `renderSong` are pure functions of their inputs and `RenderOptions`. Two calls with the same inputs produce bit-identical `Float32Array`s (golden hash tests, section 9). The realtime `Synth` produces the same samples for the same sequence of messages at the same frames.
- Randomness: noise generators are LFSRs seeded from `deriveSeed(opts.seed, channelIndex)`; sample generators use `SamplePatch.seed`; nothing else is random. The one exception is the SID noise waveform: like the chip, its register starts from the fixed reset value `0x7FFFF8` and is not seeded. `Math.random`, `Date`, `performance.now` and `crypto` are banned in core, sfx and player sources (lint test `test/no-nondeterminism.test.ts` in core greps all three packages). One file is exempt, by path, with the reason in the test: `packages/player/src/worklet/load-meter.ts`, the worklet's CPU load meter, which times `process` for the `load` figure in `clock` messages. Its reading only feeds that figure and never reaches a sample, and it takes the clock from an injected host object (`performance`, else `Date`).
- Float math: use `Math.fround` nowhere; keep plain doubles into Float32Array stores. Avoid `Math.sin` in the hot path (table lookups), so results do not depend on the platform's libm. Table construction may use `Math.sin` since it runs once and is then stored as Float32 (identical across platforms for the same inputs in practice; the golden tests pin it).

### 3.11 Performance budget

- Target: a full genesis song (10 voices, 4-op FM on 6 of them) plus 8 sfx voices at 48 kHz in under 25% of one core in the worklet (under 0.66 ms per 128-frame block). Measured by `packages/core/test/perf.bench.ts` (Vitest bench, not part of `pnpm test`).
- No allocation in `process`: no closures created, no arrays, no spread, no `Map.get` on string keys inside the per-sample loops (resolve to indexes at load time). Events are pushed into a preallocated ring of `EngineEvent` objects (512 entries) that the caller drains; event objects are reused (the worklet copies them before posting).
- Per-sample work lives in tight `for` loops over local variables; per-block work (coefficient updates, tick processing) happens at sub-block boundaries.
- Sine, exp and dB tables are `Float32Array`, built lazily once per module.

## 4. Streaming API vs offline API

### 4.1 Streaming: `createSynth`

`createSynth(opts)` returns the `Synth` interface defined in `types.ts` (section 2.2). Notes on behavior:

- `loadSong`, `loadSfx`, `setInstrument` and `setScopeBuffer` allocate and compile; the worklet calls them from its message handler, between blocks. `process` never allocates.
- `setInstrument` is the live edit path: voices currently playing that instrument pick up envelope and macro changes at once (macro index is kept when the new macro is at least as long), and the next note gets everything.
- `stop` releases every song voice and keeps the position; `pause` freezes the sequencer and lets voices sustain; `play` without arguments resumes from the current position, with `order` and `row` it jumps first. `loop: false` plays once.
- `noteOn` and `noteOff` drive a song channel by hand (studio keyboard, instrument preview) and are ignored for a channel index that the loaded chip does not have; without a loaded song the synth hosts a "custom" chip with one channel per kind so previews work on an empty project.
- `trigger` returns a handle the caller can `release` (sfx with long sustain, held jumps); the handle is a voice generation counter so a stolen voice ignores a late release.
- `channels()` returns the chip channels of the loaded song (`chipChannels(song)`), or the preview channels.

Voice stealing for sfx: pick a free voice; otherwise the voice in its release stage with the lowest current level; otherwise the oldest voice. A stolen voice gets a 2 ms fade before the new program starts (the fade frames come from the new sound's start, which is why a stolen trigger can be 2 ms late).

### 4.2 Offline: `renderSfx`, `renderSong`, `renderInstrumentNote`

All three build a `Synth` at `opts.sampleRate`, drive it with the right messages, and run `process` in 128-frame blocks until done, collecting events. They return a `RenderResult` (section 2.2).

- `renderSfx`: length is the program's duration plus `tail` (default 0.25 s), trimmed to the last frame above -90 dBFS plus 10 ms, so sfx files have no silence.
- `renderSong`: plays from order 0. With a loop it always renders at least two passes of the loop section, so the seam is real audio: the intro, the first pass, a second pass, then `tail` seconds of release. `loops` counts extra passes after the first (`loops: 1`, the default, is the minimum of two passes; `0` behaves like `1`). `loopStart` is the frame where the second pass starts (the loop order index the second time) and `loopEnd` is `loopStart` plus one pass, so the loop region is the second pass and its start is exactly what the first pass flows into. The sequencer emits a section event at every loop jump and the synth restarts its tick grid there, and FM voices reset their state at key-on, so the second pass is identical to the first and the seam is below -40 dB (typically about -100 dB or lower). When the song does not loop, `loopStart` and `loopEnd` are absent and the render stops after `halt` or the end of `order` plus `tail`. With `stems: true`, `stems[i]` holds the dry mono stem of channel `i` and `stemIds[i]` its id.
- `renderInstrumentNote`: one note for `duration` (default 0.5 s) then `release` (default 0.5 s) on the right channel kind of `chip` (default the instrument's chip or `custom`).
- `events` hold `frame` in render frames (0 at the start of the render). Loop renders emit a `loop` event at every loop start and `end` at the final frame.

Events for visuals, from any path: `noteOn` (channel, note, hz, velocity, id = instrument), `noteOff`, `trigger` (sfx id, channel -1), `row` (order, row, id = pattern), `loop`, `end`.

### 4.3 Scope reader

`createScopeReader(rings, sampleRate)` returns `{ latest(channel, frames): Float32Array, at(channel, frame, frames): Float32Array }` which copies from the ring into a reused output buffer. `at(channel, frame, frames)` copies the window of `frames` samples that STARTS at engine frame `frame` (the window is `[frame, frame + frames)`, so `latest(channel, n)` equals `at(channel, head - n, n)`). It lets the UI ask for the samples that were playing at a given engine frame, which is how the studio aligns scopes to the audio clock: the UI knows `(engineFrame now) = lastClockFrame + (audioContext.currentTime - lastClockTime - outputLatency) * sampleRate`.

## 5. AudioWorklet protocol

### 5.1 Threads and roles

`@bleepkit/player/worklet` (`src/worklet/processor.ts`) registers `bleepkit-engine` as an `AudioWorkletProcessor`. It owns one `Synth` and translates messages. `createEngineNode(ctx, opts)` in `src/engine-node.ts` loads the module and returns a typed wrapper:

```ts
interface EngineNode {
  node: AudioWorkletNode;
  send(msg: ToWorklet): void;
  on(handler: (msg: FromWorklet) => void): () => void;
  /** Engine frame that is playing out of the speakers right now (clock message + currentTime + outputLatency). */
  nowFrame(): number;
  scopes: ScopeReader;          // same interface whether shared memory or posted copies feed it
  dispose(): void;
}
```

Messages are the `ToWorklet` and `FromWorklet` unions in `types.ts`. Documents cross the boundary by structured clone, already normalized by the main thread; the worklet never calls `normalize*`. The worklet never throws across the boundary: errors become `{ type: "error" }`.

### 5.2 Timing

- Every 1024 frames the worklet posts `clock` with its `frame` and `currentTime` (the processor reads `currentTime` from the global scope at the block where it posts). The main thread stores both and computes playing frame as above. `events` messages carry the same pair so a note on at `frame` maps to `time = clockTime + (frame - clockFrame) / sampleRate + outputLatency`.
- `trigger` messages carry a `handle` chosen by the main thread (monotonic counter) so the game can `release` it later; the worklet maps handle to voice.
- The main thread sends `play` and `seek` and the worklet applies them at the start of its next block (one block of latency, accepted).

### 5.3 Scope data

When `crossOriginIsolated` is true, `createEngineNode` allocates a `SharedArrayBuffer` of `4 + 4 * frames * (maxChannels + 2)` bytes (`maxChannels` = 10), sends `setScopeBuffer`, and the synth writes its rings straight into it. The UI reads with `createScopeReader` at animation rate, lock free (a torn read is acceptable for a scope). Otherwise the worklet posts a `scope` message every 1024 frames with copies of the last 1024 frames per channel (10 + 2 Float32Arrays, transferred). The `ScopeReader` interface hides which path is active.

The CLI's studio server sends the headers `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, and the Vite dev config does the same, so the shared path is the normal one. Google Fonts are loaded with `crossorigin` so COEP allows them.

### 5.4 Bundling

The worklet is shipped as one self-contained JavaScript file so that no bundler has to understand AudioWorklet imports: `packages/player/build-worklet.ts` runs esbuild on `src/worklet/processor.ts` (bundling `@bleepkit/core` into it, format `esm`, target `es2022`, minify off, no source map in the package) and writes `packages/player/worklet/bleepkit-worklet.js`. The file is gitignored and generated by `pnpm --filter @bleepkit/player build:worklet`, which the root `dev`, `build` and `pretest` scripts run (the scaffolder wires this, like Pixelkit's `build:eject`). The `package.json` export `"./worklet"` points at that file; `publishConfig` keeps the same path, and `files` includes `worklet/`.

Consumers on Vite write:

```ts
import workletUrl from "@bleepkit/player/worklet?url";
const player = await createPlayer({ workletUrl });
```

`?url` makes Vite serve the file as is in dev and copy it as an asset in build, which is right for a file with no imports. Without `workletUrl`, `createPlayer` falls back to `new URL("../worklet/bleepkit-worklet.js", import.meta.url)`, which works for plain `<script type="module">` pages served from `node_modules`. The processor registers with `registerProcessor("bleepkit-engine", BleepkitProcessor)` guarded by `typeof registerProcessor === "function"`, and exports the class so tests can instantiate it with a fake port and a fake `createSynth`.

### 5.5 Player on top of the node

```ts
interface PlayerOptions {
  context?: AudioContext;       // created lazily on first user gesture when omitted
  workletUrl?: string | URL;
  manifest?: AudioManifest;     // from audio.ts or loadManifest
  /** "files" plays rendered files via AudioBufferSourceNode; "synth" sends documents to the worklet; "auto" (default) uses synth when the manifest embeds data, files otherwise. */
  mode?: "files" | "synth" | "auto";
  buses?: { sfx?: number; music?: number; master?: number };  // initial volumes 0..1
  maxSfxVoices?: number;        // default 8 (files mode: concurrent buffer sources; synth mode: forwarded)
}
interface BleepPlayer {
  context: AudioContext;
  resume(): Promise<void>;                     // call on a user gesture
  sfx(id: string, opts?: { velocity?: number; pan?: number; pitch?: number; loop?: boolean }): SfxHandle;
  music(id: string, opts?: { fadeIn?: number; loop?: boolean; startAt?: number }): Promise<SongHandle>;
  stopMusic(opts?: { fadeOut?: number }): void;
  setVolume(bus: "sfx" | "music" | "master", v: number, rampSeconds?: number): void;
  mute(on: boolean): void;
  on(type: "noteOn" | "noteOff" | "trigger" | "row" | "loop" | "end", fn: (e: PlayerEvent) => void): () => void;
  preload(ids?: string[]): Promise<void>;      // decode files up front
  dispose(): void;
}
interface PlayerEvent extends EngineEvent { time: number }   // AudioContext time the event is audible
interface SfxHandle { stop(): void; readonly id: string; readonly handle: number }
interface SongHandle { stop(opts?: { fadeOut?: number }): void; readonly id: string; position(): SongPosition | null }
```

Files mode: music loops seamlessly with `AudioBufferSourceNode.loop = true`, `loopStart`/`loopEnd` from the manifest (seconds); events for visuals come from the `.events.json` file, replayed on a timer against `source start time`. Sfx polyphony in files mode: a per-id cap of 4 simultaneous instances plus the global `maxSfxVoices` cap (oldest stopped). In synth mode the worklet does all of it.

## 6. CLI

Binary `bleepkit`, built with esbuild into `packages/cli/dist/index.mjs` like Pixelkit; source `packages/cli/src/cli.ts` (arg parsing and dispatch), `commands/*.ts` (one file per command), `server/*.ts` (studio server), `project.ts` (folder discovery and loading), `output.ts` (human and JSON output).

### 6.1 Global behavior

- Project discovery: `--project <dir>` wins; else walk up from cwd looking for `project.json` whose parsed JSON has a numeric `version` and either `chip` or `export`; else `audio/project.json` under cwd; else error exit 3 (except `init` and `studio`, which take a path).
- `--json`: every command prints exactly one JSON object on stdout and nothing else on stdout; human text and progress go to stderr. Without `--json` the human output goes to stdout.
- `--quiet` suppresses progress; `--seed <n>` overrides the project seed for the run; `--help` per command.
- Exit codes: 0 ok; 1 the command ran and the result is "bad" (validation errors, diff found, clipping over threshold when `--strict`); 2 usage error (unknown command, missing arg, bad flag); 3 project not found or unreadable; 4 file not found (the document or render named); 5 encoder failure or write failure; 6 the studio server could not bind.
- Any `--json` error output has the shape `{ "ok": false, "error": { "code": "...", "message": "..." } }` with codes `usage`, `no-project`, `not-found`, `invalid`, `encode`, `write`, `bind`.
- Document references: `sfx/coin`, `song/title`, `instrument/lead` or a bare id with the kind implied by the command. Ids are validated against `^[a-z0-9][a-z0-9-]{0,63}$`.

### 6.2 Commands

| command | does | output |
| --- | --- | --- |
| `bleepkit init [dir] [--chip nes] [--name <s>] [--force]` | creates the folder (default `audio`), `project.json`, empty `sfx/ instruments/ songs/ out/`, a `.gitignore` with `out/`, three starter instruments and one starter sfx for the chip | `{ ok, dir, files: string[] }` |
| `bleepkit new sfx <id> --category coin [--chip] [--seed] [--name]` | generates with `@bleepkit/sfx`, writes `sfx/<id>.json`, exits 1 if it exists (`--force` overwrites) | `{ ok, path, doc, description }` |
| `bleepkit new instrument <id> --kind pulse [--chip] [--preset lead|bass|drums|pad|bell]` | writes a default instrument | `{ ok, path, doc }` |
| `bleepkit new song <id> [--chip] [--tempo 120] [--mml "<ch>=<mml>" ...] [--template empty|loop8]` | writes a song; `--mml pulse1="o4 l8 cdefgab>c"` sets a channel's MML; `loop8` is 8 bars of empty patterns with a loop at order 0 | `{ ok, path, doc }` |
| `bleepkit mutate <ref> [--amount 0.15] [--count 1] [--seed] [--out <id>]` | sfx only today; writes `<id>-m1.json`... (or `--out`) and prints descriptions | `{ ok, results: [{ id, path, description }] }` |
| `bleepkit validate [ref...]` | normalizes every document (or the named ones) with the instrument map; exit 1 when any error | `{ ok, documents: [{ ref, ok, issues }] }` |
| `bleepkit list [sfx|songs|instruments]` | lists documents with name, chip, category or kind, duration when a render exists in `out/` | `{ ok, sfx: [...], songs: [...], instruments: [...] }` |
| `bleepkit render [ref...] [--format wav] [--loops 1] [--tail 1] [--stems] [--analyze] [--images] [--rate 48000]` | renders to `out/<kind>/<id>.wav` (`.ogg`/`.mp3` with `--format`), writes `<id>.events.json`; `--loops` is the number of extra passes of a looping song after the first (minimum 1, so a render always holds the intro and two passes and `loopStart` / `loopEnd` bracket the second); `--analyze` adds the analysis JSON; `--images` writes `out/analysis/<id>.waveform.png`, `.spectrogram.png`, `.scopes.png`; no refs = everything | `{ ok, renders: [{ ref, path, duration, loopStart, loopEnd, peakDb, rmsDb, clipped, analysis? }] }` |
| `bleepkit analyze <file or ref> [--images] [--pitch] [--window 2048]` | analysis of a render in `out/` or any wav/ogg path; renders first when `out/` is stale or missing (render if the document is newer) | the `Analysis` object (section 6.4) with `ok: true` |
| `bleepkit play <ref> [--studio http://localhost:5174] [--visual]` | POSTs `/api/play` to the running studio; exit 4 when no studio answers | `{ ok, studio }` |
| `bleepkit export [--dir] [--manifest] [--sfx-format] [--music-format] [--embed] [--clean] [--dry-run]` | renders everything whose render is stale, encodes to the project's export formats, writes files to `export.dir`, writes the manifest; `--clean` removes files in `export.dir` that no document produces; `--dry-run` lists what would change | `{ ok, written: string[], removed: string[], manifest, warnings: string[] }` |
| `bleepkit studio [dir] [--port 5174] [--open] [--no-open]` | starts the server (section 6.3) and serves the built studio; prints the URL; runs until Ctrl-C | streams `{ type: "listening", url }` then one line per file event in `--json` |
| `bleepkit describe <ref>` | the text description of an sfx (or a song summary: channels, length, loop, notes per channel) for agents | `{ ok, description }` |

Staleness: a render in `out/` is stale when the document's mtime, any instrument it references, or `project.json` is newer than the render, or when the render's sidecar `out/<kind>/<id>.meta.json` (holding `{ hash }` of the normalized documents and options) does not match the current hash. `render` and `export` use the hash, not mtime, as the final word. The hash covers the normalized documents, the effective options, the project's master settings, the CLI's pipeline version and core's `ENGINE_VERSION` (`packages/core/src/version.ts`, a string exported from `@bleepkit/core`). `ENGINE_VERSION` is the version of the sound: it is bumped by hand in the same change that moves a golden hash on purpose, and that makes every render in every project stale (the next `render` or `export` redoes it, `list` shows it as stale) so an old `out/` never passes for the new sound. Core's golden test enforces the discipline: each `test/golden/<id>.json` stores the `engineVersion` it was made under, the test fails with a message naming `ENGINE_VERSION` when the hashes moved or the versions differ, and `UPDATE_GOLDEN=1` refuses to rewrite moved hashes under a version the file already holds. The WAV files the CLI writes carry `ISFT: bleepkit <cli version>` (section 8).

### 6.3 Studio server

HTTP on `127.0.0.1:<port>` (default 5174). Serves `apps/studio/dist` at `/` with COOP and COEP headers, and the API under `/api`. All API responses are JSON. Paths are always relative to the project folder, forward slashes, restricted to `project.json`, `sfx/*.json`, `instruments/*.json`, `songs/*.json`, `out/**`; anything else is 403.

| method and path | does |
| --- | --- |
| `GET /api/project` | `{ root, project: Project, files: FileEntry[] }` where `FileEntry = { path, kind: "project"|"sfx"|"instrument"|"song"|"render", mtime, size, etag }` |
| `GET /api/file?path=` | `{ path, etag, mtime, json }` for JSON, or the raw bytes with the right content type for `out/` files (`Range` supported for audio) |
| `PUT /api/file?path=` body `{ json, ifMatch?: etag }` | writes the file atomically (temp then rename). 412 with `{ error: "conflict", etag, json }` when `ifMatch` is set and differs (the client decides: reload or overwrite with `ifMatch` omitted). Normalizes first; 422 with issues when not ok. |
| `DELETE /api/file?path=` | deletes; 404 when missing |
| `POST /api/render` body `{ ref, options }` | renders through the same code as the CLI, returns the `render` command's entry for that ref; `out/` files appear and a `file` event is broadcast |
| `POST /api/analyze` body `{ ref }` | analysis JSON |
| `POST /api/export` body `{ dryRun? }` | the export command's result |
| `POST /api/play` body `{ ref, visual?: boolean }` | broadcasts a `play` websocket message to every connected studio; `{ ok, clients }` |
| `GET /api/health` | `{ ok, version, root }` |

WebSocket at `/ws` (the server uses Node's `http` plus the `ws` package; the only runtime dependencies of the CLI are `ws` and `wasm-media-encoders`). Server to client messages (JSON):

```ts
type ServerMessage =
  | { type: "hello"; root: string; project: Project }
  | { type: "file"; path: string; etag: string; mtime: number; json?: unknown }   // created or changed on disk (json included for documents under 256 KB)
  | { type: "deleted"; path: string }
  | { type: "play"; ref: string; visual: boolean }
  | { type: "render"; ref: string; status: "started" | "done" | "failed"; result?: unknown }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };
```

The watcher uses `fs.watch` recursively (Node 22 supports recursive on Linux and macOS) with 50 ms debounce per path. A write made through `PUT /api/file` also triggers a `file` broadcast; clients ignore it when the etag matches what they just wrote. Etag = sha1 of file bytes, 12 hex chars.

Conflict handling in the studio: the studio keeps the etag of each open document. A `file` message with a different etag for a document the user has not changed since loading replaces it silently (and flashes the file in the sidebar). For a document with unsaved local edits it shows a bar "Changed on disk" with Reload and Keep mine (Keep mine saves with `ifMatch` omitted). Saving with a stale etag gets 412 and the same bar.

### 6.4 Analysis object

```ts
interface Analysis {
  file: string; sampleRate: number; channels: number; frames: number; duration: number;   // seconds
  peakDb: number; rmsDb: number; lufs: number;        // lufs: K-weighted integrated loudness approximation (BS.1770 with the standard filters, no gating refinements)
  crestDb: number; dcOffset: number;
  clipped: { frames: number; first: number | null }; // |x| >= 0.999
  silenceDb: number;                                  // level of the quietest 50 ms window
  leadingSilence: number; trailingSilence: number;    // seconds under -60 dBFS at the ends
  loop: { start: number; end: number; seamDiffDb: number | null } | null;   // seconds; seamDiffDb: RMS (dBFS) of the difference between the 5 ms before `end` and the 5 ms before `start`, which is what a loop jump would splice; below -40 dB is clean; null when `start` is under 5 ms (nothing precedes it to compare)
  spectrum: { centroidHz: number; bands: { lowDb: number; midDb: number; highDb: number } };  // 20..250, 250..4000, 4000..nyquist
  pitch: { medianHz: number | null; medianNote: string | null; track: { time: number; hz: number | null; confidence: number }[] };  // track hop 512 frames, trimmed to 200 entries max in --json unless --pitch
  envelope: { time: number; db: number }[];           // RMS every 10 ms, max 1000 points
  dutyCycle: number | null;                           // null unless the signal is a two-level pulse; the CLI passes the sfx `wave` when known and `analyze` of plain files leaves it null
  images?: { waveform: string; spectrogram: string; scopes?: string };  // paths written with --images
}
```

Human output of `analyze` is a compact block: duration, peak, RMS, LUFS, clipping, pitch and a 60-column ASCII envelope.

### 6.5 Studio standalone mode

When the studio is opened without a server (`/api/health` fails or the page is served from a static host), it uses an in-browser project stored in IndexedDB (`bleepkit-studio` database, one object store `files` keyed by path, same shapes as the server). Import: drop a folder (File System Access API when available, else a zip) or a single JSON file. Export: download a zip of the project (JSZip-free: the studio has its own tiny stored-zip writer in `src/zip.ts`, no compression needed), or a single document, or a render. The `play` endpoint does not exist standalone. Everything else behaves the same because the studio talks to a `ProjectStore` interface (`src/store/store.ts`) with two implementations: `server.ts` and `local.ts`.

## 7. The typed manifest

`export` writes `audio.ts` at `project.export.manifest`:

```ts
/* Generated by bleepkit export. Do not edit. */
import type { AudioManifest } from "@bleepkit/player";

export const sfx = {
  coin: "coin.ogg",
  laser: "laser.ogg",
} as const;

export const songs = {
  title: { file: "title.ogg", loopStart: 4.8, loopEnd: 24.0, duration: 25.0 },
} as const;

export type SfxId = keyof typeof sfx;
export type SongId = keyof typeof songs;

export const manifest = {
  base: "/audio/",
  sampleRate: 48000,
  sfx: { coin: { file: "coin.ogg", duration: 0.31 }, laser: { file: "laser.ogg", duration: 0.42 } },
  songs: { title: { file: "title.ogg", duration: 25.0, loopStart: 4.8, loopEnd: 24.0, events: "title.events.json" } },
} as const satisfies AudioManifest;
```

The manifest is written `as const satisfies AudioManifest`, not annotated `: AudioManifest`. An annotation would widen the keys to `string` and `createPlayer({ manifest })` could no longer type the ids; `as const` keeps the literal keys and `satisfies` still checks the shape against the player's `AudioManifest`. Embedded documents (`data`) are the one exception: `as const` would turn every array in them readonly, which `AudioManifest` rejects, so each `data` literal is cast to `NonNullable<ManifestSfx["data"]>` or `NonNullable<ManifestSong["data"]>` (the generated file then also imports `ManifestSfx` and `ManifestSong`). The CLI tests type-check a generated `audio.ts`, with and without `embed`, against `@bleepkit/player` with `tsc`, including that a wrong id does not compile.

With `embed: true`, `manifest.sfx.<id>.data` and `manifest.songs.<id>.data` carry the normalized documents and the player can synthesize them (then `file` is still written so games can choose). `export` also writes `manifest.json` (the same object) into `export.dir` for `loadManifest`. Ids become keys verbatim (they are valid identifiers when quoted; the generator quotes keys that contain dashes).

`createPlayer({ manifest })` is typed so `player.sfx("coin")` accepts only `SfxId` when the game passes `manifest` from `audio.ts` (through a generic on `AudioManifest`'s keys, `createPlayer<M extends AudioManifest>(opts) : BleepPlayer<keyof M["sfx"] & string, keyof M["songs"] & string>`).

## 8. Export formats and loop gaps

- Masters are 16-bit WAV in `out/`, always, with a `smpl` chunk holding one loop (`loopStart`, `loopEnd` in frames, type forward) when the song loops, and a `LIST INFO` chunk with `ISFT: bleepkit <version>` and `ICMT: <id>`.
- Game music defaults to OGG Vorbis (quality 6), which is gapless: loop points from the manifest in seconds line up with the decoded buffer. The player uses `loopStart` / `loopEnd` on the buffer source, so the render contains the intro, two passes and the tail, and the game loops the second pass (`loopStart` to `loopEnd`).
- MP3 is optional (`musicFormat: "mp3"`) because MP3 adds encoder delay (1105 frames with LAME-style encoders) and end padding, so decoded audio is offset and longer and a buffer loop has a gap or a click. `export` compensates by writing the manifest `loopStart` / `loopEnd` shifted by the encoder delay (hard coded 1105 frames at the encode rate, since `wasm-media-encoders` does not report it) and warns in its output: "MP3 loop points are approximate; use OGG for seamless loops". Sfx in MP3 keep their file; only the manifest `duration` excludes the delay.
- Safari: treat Safari as unable to decode OGG Vorbis in `decodeAudioData` (the player's `loadManifest` probes `canPlayType('audio/ogg; codecs=vorbis')` and reports it). Games that need Safari either set both formats to `mp3` and accept approximate loops, or set `embed: true` and use synth mode, which needs no files at all. Recommended for Safari: synth mode.
- `wasm-media-encoders` (version 0.7.0, pinned exactly) is loaded with `createOggEncoder()` / `createMp3Encoder()` from a dynamic import; the WASM is fetched by the package in the browser and read from `node_modules` in Node. Encoding runs in the main thread of the CLI (it is fast) and in a Web Worker in the studio (`src/workers/encode.ts`).

## 9. Testing strategy

Every package has `test/`. Fixtures live in `packages/core/test/fixtures/` (documents) and are the only fixtures; other packages import them by relative path (`../../core/test/fixtures/...`). Engineer A writes the fixtures in day one (section 10).

- DSP unit tests (core): pulse duty ratio by counting samples above zero over 100 cycles (within 1%); frequency by zero crossings and by FFT peak (within 0.5% at 440 Hz for every oscillator and FM at low index); NES period quantization reproduces known cents errors (A-7 on NES pulse is sharp by a known amount); envelope timing: attack reaches 0.99 within attack seconds plus 1 ms, release falls below -60 dB within release seconds times 1.2; macro loop and release indexes; LFSR noise short mode has period 93 or 31 in NES; SID filter cutoff lowers the FFT energy above cutoff by at least 12 dB per octave; limiter never exceeds -0.3 dBFS on a +12 dB input; echo repeats at the delay time (cross correlation peak).
- Sequencer tests: a pattern with notes at rows 0, 4, 8 emits noteOn events at the expected frames for tempo 120 and 150; `jump`, `skip`, `halt`, loop points; MML and the equivalent pattern produce identical event lists; effects per tick values at tick 0, 1, 2.
- Loop and level tests (core): seam below -40 dB on every fixture and chip demo and below -80 dB for an FM song with an LFO; one render has one `loop` event and `loops: 3` has three; FM key-on resets operator state; a full-volume square peaks -12 dBFS +-1.5 dB on all 7 chips; sfx honor `RenderOptions.master`; the sfx FM index is pinned in radians (Bessel sideband ratio); genesis tone3 rate table; `onSection` events from the sequencer; `seamDiffDb` null cases. In sfx: `noiseSweep` caps, noise start clamps (60 to 250 Hz boom on nes/gameboy, 300 to 1500 Hz steps) and FM modulator and bandwidth bounds.
- Golden tests: for every fixture document, `renderSfx` / `renderSong` at 48000 and 44100 produce a Float32 output whose FNV-1a hash of the raw bytes matches `test/golden/<id>.json`. A changed golden must be updated on purpose: bump `ENGINE_VERSION` (section 6.2), run `UPDATE_GOLDEN=1 pnpm test` (it refuses to move hashes under an unbumped version), and review by listening (the orchestrator) or by analysis diff. The same test renders twice and asserts bit equality (determinism) and renders through `createSynth` in 128-frame blocks versus 64-frame blocks and asserts equality (block-size independence).
- Normalize tests: every rule in section 2 has a test with the issue path and severity; round trip `normalize(normalize(x).value)` yields zero issues and deep-equal output; the compact row string form and the typed form normalize to the same thing; version greater than FORMAT_VERSION is an error.
- MML tests: each grammar element; `formatMml(parseMml(x).events)` reparses to the same events; error positions.
- Sfx tests: every category at 20 seeds normalizes with zero errors, renders under 10 s, has peak above -20 dBFS, and `describeSfx` mentions the category; `mutateSfx` with amount 0 is identity; same seed same result.
- Tools tests: WAV round trip bit exact for 16 and 32-float, `smpl` chunk read back; PNG decodes with a reference decoder (a tiny inflate-free check: we write stored blocks so a test can parse the IDAT by hand and compare pixels); analysis of a generated 440 Hz sine at -6 dBFS reports peak -6 dB, RMS -9 dB, pitch 440 within 1 Hz, zero clipping; OGG and MP3 encode a 1 s sine: the test asserts the container signatures (`OggS` pages, MP3 frame sync bytes), a plausible byte size for the bitrate, and that two encodes of the same input are byte identical (no decoder is available in the test environment).
- CLI tests: run `cli.ts` in a temp dir through `node --experimental-strip-types` (or the built bundle) with `child_process`: `init` then `new sfx` then `validate` then `render --json` then `analyze --json` then `export --dry-run`, asserting JSON shapes and exit codes; the studio server with an ephemeral port: `GET /api/project`, `PUT` with a stale etag returns 412, a write from disk produces a websocket `file` message.
- Player tests: node side only: files mode scheduling math (loop points to buffer seconds), voice cap logic, event replay timing; the worklet processor's message handling by calling the processor class with a fake port.
- Studio tests (happy-dom): the app boots against a fake `ProjectStore`, the pads view lists sfx, pressing a pad calls `trigger` on a fake engine node, the tracker renders rows, keyboard shortcuts dispatch, `prefers-reduced-motion` disables the backdrop animation class. Canvas drawing functions are tested by calling them on an `OffscreenCanvas` stub that records calls.

## 10. Work breakdown and file ownership

Six workstreams. The scaffolder owns root files (`package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `vitest.config.ts`, `biome.jsonc`) and each package's `package.json` and `tsconfig.json`. If a workstream needs a dependency added to its `package.json`, it adds it itself (the scaffolder creates the files, then ownership of `packages/<own>/package.json` passes to the workstream).

Step zero (engineer A, first hour, before anything else): create `packages/core/src/types.ts` verbatim from section 2.2, `packages/core/src/prng.ts`, `packages/core/src/notes.ts`, and the fixtures `packages/core/test/fixtures/{project.json, sfx-coin.json, instrument-lead.json, instrument-fm-bass.json, instrument-snes-pluck.json, song-title.json}` with the examples from this document (plus the two instruments described in 2.5). Commit. Everyone else starts from that commit.

| stream | owns | starts | needs from others | stub it uses meanwhile |
| --- | --- | --- | --- | --- |
| A: core engine, formats, MML | `packages/core/src/**` except `src/tools.ts` and `src/tools/**`; `packages/core/test/**` except `test/tools/**` | now | nothing | none |
| B: sfx | `packages/sfx/**` | now, against `types.ts` | `normalizeSfx` and `renderSfx` from A for its tests | until A lands, B's tests call a local `normalizeSfx` stub in `packages/sfx/test/stub-core.ts` that only checks ranges from section 2.2; replace with the real import when A's normalize merges (B deletes the stub) |
| C: tools | `packages/core/src/tools.ts`, `packages/core/src/tools/**`, `packages/core/test/tools/**` | now, against `RenderResult` | nothing (it tests with synthetic sine buffers) | none |
| D: CLI and studio server | `packages/cli/**` | now | A (normalize, render), B (generate), C (encode, analyze) for integration tests | `packages/cli/src/stubs.ts` re-exports from the real packages when present; D writes command code against the signatures in section 1 and runs the round trip test once A, B, C land. D can finish `init`, `list`, `validate` (with the stub normalize that returns `{ ok: true, value: input, issues: [] }`), the server, the watcher, and the manifest writer first |
| E: player | `packages/player/**` | now, against `ToWorklet`, `FromWorklet`, `Synth` | A's `createSynth` for the processor | `packages/player/test/fake-synth.ts`, a `Synth` that writes a sine and emits one noteOn per `play`; the processor takes a `createSynth` factory parameter for this |
| F: studio | `apps/studio/**` including `apps/studio/src/pixelkit/**` (ejected from Pixelkit with its CLI: `npx pixelkit init --dir src/pixelkit --ext ts` then `add` the generators listed in 11.5) | now | E's `createEngineNode`, A's normalize and MML, B's generators, C's analysis images for the analysis view | `apps/studio/src/dev/fake-engine.ts`, an `EngineNode` that synthesizes a sine on the main thread with a ScriptProcessor-free approach: a `setInterval` that posts fake `clock`, `events` and `scope` messages; F builds every view against it and switches with a query flag `?engine=fake` that stays in the code for DOM tests |

Integration order once all land: A -> C and B tests switch to real core -> E processor uses real `createSynth` -> D round trip test -> F against real engine. The orchestrator runs `pnpm verify` at each step.

Interfaces frozen by this document that streams rely on: everything in `types.ts`; the function signatures in section 1; the worklet messages (section 5); the HTTP and websocket API (section 6.3); the manifest (section 7). A stream that needs a change asks the orchestrator, who edits this document and `types.ts` (A applies the `types.ts` edit).

## 11. Studio UX spec

### 11.1 Shell

Vite app, vanilla TypeScript, one `index.html` with the styles inline like Pixelkit's studio, `src/main.ts` boots the router (`#/pads`, `#/sfx/<id>`, `#/song/<id>`, `#/instrument/<id>`, `#/analysis/<ref>`, `#/project`). Layout: top bar (brand "BLEEPKIT" in Silkscreen with a small accent word "studio", transport in the middle, status on the right), a left sidebar (the project tree: SFX, Songs, Instruments, with search and a "+ New" per section), a center stage (the view), a right inspector (the selected thing's parameters). On narrow screens the stage pins to the top and the panels stack under it, like Pixelkit. Everything in the inspector is a plain `<label>` with a range input, number input, select or toggle, in a two-column grid; sliders show their value in JetBrains Mono.

The whole page sits on the Pixelkit backdrop (section 11.5), with the panels at 92% opacity over it so the backdrop glows through the gaps. The stage canvas views are opaque.

### 11.2 Views

- Pads (home, `#/pads`): a grid of every sfx as a square pad (category color, name, duration, waveform thumbnail drawn from the last render). Click or tap plays at once and the pad bursts (ring expanding, waveform flashes). Keys 1..9 and 0 play the first ten pads; `Q..P` the next ten. Each pad has a small `mutate` button (dice icon) that creates 4 variants in a drawer under the pad, each playable; `keep` saves a variant as a new document; `randomize` on the pad replaces the pad's sfx with a fresh one of the same category (undoable). A "+ New SFX" pad at the end opens a category picker (13 categories with an icon each and a one-line hint); choosing one generates and plays immediately. Primary action of the view: play. Secondary: mutate.
- SFX editor (`#/sfx/<id>`): big waveform on top (drawn from a fresh render every change, debounced 60 ms, rendered in a Worker so the UI never stalls), the spectrogram below as a toggle, the inspector with every field of section 2.4 grouped as sfxr does (Wave, Envelope, Frequency, Vibrato, Arpeggio, Duty, Repeat, Phaser, Filter, Crush). Space plays. `R` randomizes, `M` mutates (replaces with one mutation, undoable), chip selector at the top with a live hint when a field is not available on the chip (grayed, tooltip "nes has no filter"). A "Play on every change" toggle (default on). A lock icon per field group keeps it fixed while randomizing.
- Song editor (`#/song/<id>`): tracker grid on the stage: columns per channel (color per kind), rows with note, instrument, volume and up to 2 visible effect columns (expand per channel), monospaced, keyboard entry like Famitracker (piano keys on the computer keyboard, `Z S X D C V G B H N J M` for the lower octave and `Q 2 W 3 E R 5 T 6 Y 7 U` for the upper, `1` for note off, `` ` `` for release, Delete clears, arrows move, Tab next column, Shift-Tab previous, Page Up/Down 16 rows, Home/End). Above the grid: order list (pattern chips, drag to reorder, click to edit, `+` duplicates), tempo, rows per beat, loop point marker. The playhead row is highlighted and the grid follows it while playing (toggle `F` to follow). Each channel header has mute (`click`), solo (`alt click`), an oscilloscope (section 11.4) and the MML toggle: switching a channel to MML shows a text editor for the channel with live error underlines from `parseMml`; converting back runs `mmlToTrack`. Right side inspector: the current channel's instrument (click to open) and the song master.
- Instrument editor (`#/instrument/<id>`): on the stage a piano keyboard (two octaves, mouse and computer keys play it through `noteOn`) with keys lighting while notes play, and a stacked view of the macro editors (bar graphs you draw with the mouse, loop and release markers you drag) plus the kind specific panel: pulse duty picker (four pixel-art icons showing the duty shape), wavetable editor (32 x 16 grid, draw with mouse, presets sine/tri/saw/square/organ), SID panel (waveform toggles, PWM, ring, sync, filter), FM panel (algorithm picker drawn as 8 pixel-art diagrams, 4 operator strips with envelope mini graphs, feedback), sample panel (generator select, params, Regenerate with a new seed, the generated waveform). A "Test note" row: note select, duration, Play.
- Analysis (`#/analysis/<ref>`): the analysis JSON as cards (peak, RMS, LUFS, duration, loop seam, pitch) with the three images drawn live on canvas from `core/tools` functions (not the PNGs), and a "Copy as JSON" button for agents. A clipping warning is red.
- Project (`#/project`): the project settings and export panel with a live preview of `audio.ts`, an Export button with a progress bar, and the list of what is stale.

### 11.3 Transport and global shortcuts

Space play/pause the current thing (song, sfx, or instrument test note), `Escape` stop everything, `Ctrl+S` save (also autosaves 800 ms after the last change when the "autosave" toggle is on, default on), `Ctrl+Z` / `Ctrl+Shift+Z` undo and redo (per document, 200 steps, like Pixelkit's history), `Ctrl+K` command palette (every action by name, fuzzy), `?` shortcut sheet, `[` and `]` previous and next document in the sidebar, `Ctrl+E` export, `Ctrl+Shift+A` open analysis for the current document. Numbers 1..0 on the pads view only. The transport shows the engine time in `mm:ss.ms`, the order and row, the CPU load reported by the worklet (time in `process` over block time, averaged), and the audio latency.

An unlocked AudioContext needs a gesture: the first click anywhere resumes it; until then a small "Click to enable audio" pill pulses at the bottom (accent colored).

### 11.4 Visuals

All canvas, all at `devicePixelRatio`, all driven by one `requestAnimationFrame` loop in `src/visuals/loop.ts` that reads the engine clock once per frame and gives every visual `{ frame, time, events since last frame }`. Under `prefers-reduced-motion` every visual draws its still state (scopes show a flat line with the current level, no bursts, backdrop static) and the loop runs at 10 fps.

- Per-channel oscilloscopes: one per channel header in the song view, 96 x 32 CSS pixels, trigger on rising zero crossing so the wave stands still, line in the channel color with a 2-pixel glow, kind label. Reads `ScopeReader.at(channel, nowFrame - window, window)`: `frame` is the start of the window.
- Master oscilloscope and spectrum: on the stage top strip in every view, 1024-point FFT (from `core/tools` `fft`), 64 log-spaced bars with peak hold (hold 400 ms then fall 24 dB/s), bar color from the chip's palette, clipping turns the top red.
- Tracker playhead and row flash: the playing row glows for 80 ms on each `row` event; a note on in a channel column pulses the cell.
- Keyboard lighting: the piano keys in the instrument view and a small 4-octave strip in the song view light per `noteOn` in the channel color with a 150 ms fade.
- SFX pads bursting: an expanding square ring plus 8 pixel particles in the category color on `trigger`.
- Backdrop (11.5): reacts to the master level and events.
- Chip badge: the current chip's name with a pixel-art icon in the top bar; changing the chip crossfades it.

### 11.5 Pixelkit backdrop

Ejected via Pixelkit's CLI into `apps/studio/src/pixelkit/` (core plus generators `sky`, `nebula`, `embers`, `lightning`, `fireflies`, `dust`, `glow`, `crt`, `skyline`), with a studio scene per chip (`src/backdrop/scenes/<chip>.ts`): nes a night skyline with fireflies, gameboy a four-shade green sky, c64 a blue-purple nebula, genesis a dark sea skyline with embers, adlib amber dust and glow, snes a purple nebula with aurora, custom a plain starfield. The backdrop runs through the ejected renderer on a canvas behind the panels, scene `size: { mode: "fill", minPixel: 3, maxPixel: 6 }`, at 12 fps. Audio reactivity comes through `taps` and one extra layer: `src/backdrop/reactive.ts` registers a `bleep-pulse` generator (a `live: true` light layer whose intensity is the master RMS from the last scope read, so the scene breathes with the music) and sends taps: a `trigger` of category `explosion` or `hit` is a tap at a random x on the skyline layer (lightning strikes); `coin`, `powerup`, `blip` taps the embers or fireflies layer (sparkles); `noteOn` on the bass or triangle channel pulses the glow. Taps are rate limited to 8 per second. `prefers-reduced-motion` renders one settled frame.

### 11.6 Visual language

A sibling of Pixelkit's studio: the same tokens, copied into `index.html`:

```
--bg #121119  --panel #1a1924  --raised #242332  --line #312f44  --fg #ece7da  --muted #9a95ad
--accent #f3b24a  --accent-ink #1b1306  --danger #e2766f  --r 6px
fonts: Silkscreen (display, headings, brand), Atkinson Hyperlegible (body), JetBrains Mono (numbers, tracker, code)
```

Per-channel kind colors (the analog of Pixelkit's per-layer-kind colors): `--k-pulse #7d97dc`, `--k-triangle #74c08f`, `--k-noise #9a95ad`, `--k-wave #dc7ba4`, `--k-sid #b49ae6`, `--k-fm #f3b24a`, `--k-sample #e2766f`. SFX category colors reuse them: coin fm gold, laser pulse blue, explosion noise gray with a red ring, powerup sid violet, hit sample red, jump triangle green, blip pulse blue, door wave pink, alarm fm gold, teleport sid violet, step noise gray, zap pulse blue, custom muted.

Controls are pixel-art styled: 1 px hard borders, 2 px inset highlight on hover, no blur except the scope glows, `image-rendering: pixelated` for icons (icons are 8 x 8 inline SVG with `shape-rendering: crispEdges`), sliders with a square 10 px thumb, toggles as 2-frame pixel switches. Motion: 120 ms ease-out transitions on hover and selection, pad bursts 300 ms, everything through CSS variables so `prefers-reduced-motion` sets `--motion: 0` and durations become 0.

Primary actions are obvious: one accent-colored button per view (Play on pads and editors, Export on the project view), everything else is raised. Every list item has a play button on hover, so everything is previewable without opening it. Error states speak plainly in the inspector (the normalize issue text, next to the field, with the path translated to the field label).
