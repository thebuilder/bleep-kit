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
