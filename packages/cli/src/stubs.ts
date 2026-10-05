// The one seam between the CLI and the engine packages. Everything the CLI needs from @bleepkit/core,
// @bleepkit/core/tools and @bleepkit/sfx is imported from here. What the real packages already export is re-exported
// as is; what has not landed yet (checked at runtime) falls back to a small stand-in so every command still runs.
// Once the real exports exist the fallbacks are dead code: `STUBBED` lists which ones are still in use.

import type {
  ChannelKind,
  ChipId,
  EngineEvent,
  Instrument,
  Issue,
  MmlEvent,
  MmlOptions,
  Normalized,
  Project,
  RenderOptions,
  RenderResult,
  Sfx,
  SfxCategory,
  Song,
} from "@bleepkit/core";
import * as coreNs from "@bleepkit/core";
import * as toolsNs from "@bleepkit/core/tools";
import * as sfxNs from "@bleepkit/sfx";

export type * from "@bleepkit/core";
export {
  CHANNEL_KINDS,
  CHIP_IDS,
  deriveSeed,
  EFFECT_TYPES,
  FORMAT_VERSION,
  hashString,
  noteName,
  PPQ,
  SFX_CATEGORIES,
  SFX_WAVES,
} from "@bleepkit/core";

/* ---------- the signatures this CLI relies on (architecture.md sections 1.1 to 1.3) ---------- */

export interface AnalysisLike {
  channels: number;
  clipped: { frames: number; first: number | null };
  crestDb: number;
  dcOffset: number;
  duration: number;
  dutyCycle: number | null;
  envelope: { time: number; db: number }[];
  file: string;
  frames: number;
  leadingSilence: number;
  loop: { start: number; end: number; seamDiffDb: number } | null;
  lufs: number;
  peakDb: number;
  pitch: {
    medianHz: number | null;
    medianNote: string | null;
    track: { time: number; hz: number | null; confidence: number }[];
  };
  rmsDb: number;
  sampleRate: number;
  silenceDb: number;
  spectrum: {
    centroidHz: number;
    bands: { lowDb: number; midDb: number; highDb: number };
  };
  trailingSilence: number;
  [key: string]: unknown;
}

export interface PngImageLike {
  data: Uint8Array | Uint8ClampedArray;
  height: number;
  width: number;
}

export interface ImageOptionsLike {
  height?: number;
  width?: number;
  [key: string]: unknown;
}

interface ChipProfileLike {
  channels: readonly {
    id: string;
    kind: ChannelKind;
    label: string;
    fmOps?: 2 | 4;
    fixedDuty?: number;
  }[];
  kinds: readonly ChannelKind[];
  label: string;
}

interface CoreApi {
  chipProfile: (id: ChipId) => ChipProfileLike;
  defaultInstrument: (kind: ChannelKind, chip?: ChipId) => Instrument;
  defaultProject: (name?: string) => Project;
  defaultSfx: (chip?: ChipId) => Sfx;
  defaultSong: (chip?: ChipId) => Song;
  issuesToText: (issues: readonly Issue[]) => string;
  normalizeInstrument: (input: unknown) => Normalized<Instrument>;
  normalizeProject: (input: unknown) => Normalized<Project>;
  normalizeSfx: (input: unknown) => Normalized<Sfx>;
  normalizeSong: (
    input: unknown,
    instruments?: Record<string, Instrument>
  ) => Normalized<Song>;
  parseMml: (
    src: string,
    opts?: MmlOptions
  ) => {
    events: MmlEvent[];
    issues: Issue[];
    loopPulse: number | null;
    tempo: number | null;
  };
  renderSfx: (sfx: Sfx, opts?: RenderOptions) => RenderResult;
  renderSong: (
    song: Song,
    instruments: Record<string, Instrument>,
    opts?: RenderOptions
  ) => RenderResult;
}

interface ToolsApi {
  analyze: (
    r: RenderResult,
    opts?: { file?: string; maxTrack?: number; pitchWindow?: number }
  ) => AnalysisLike;
  decodeWav: (bytes: Uint8Array) => RenderResult;
  encodeMp3: (
    r: RenderResult,
    opts?: { bitrate?: number }
  ) => Promise<Uint8Array>;
  encodeOgg: (
    r: RenderResult,
    opts?: { quality?: number }
  ) => Promise<Uint8Array>;
  encodePng: (
    img: PngImageLike,
    deflate?: (data: Uint8Array) => Uint8Array
  ) => Uint8Array;
  encodeWav: (r: RenderResult, opts?: { bits?: 16 | 24 | 32 }) => Uint8Array;
  scopesImage: (r: RenderResult, opts?: ImageOptionsLike) => PngImageLike;
  spectrogramImage: (r: RenderResult, opts?: ImageOptionsLike) => PngImageLike;
  waveformImage: (r: RenderResult, opts?: ImageOptionsLike) => PngImageLike;
}

interface SfxApi {
  describeSfx: (sfx: Sfx) => string;
  generateSfx: (
    category: SfxCategory,
    opts: { seed: number; chip?: ChipId; name?: string }
  ) => Sfx;
  mutateMany: (
    sfx: Sfx,
    opts: { seed: number; amount?: number; count: number }
  ) => Sfx[];
  mutateSfx: (sfx: Sfx, opts: { seed: number; amount?: number }) => Sfx;
}

const realCore = coreNs as unknown as Partial<CoreApi>;
const realTools = toolsNs as unknown as Partial<ToolsApi>;
const realSfx = sfxNs as unknown as Partial<SfxApi>;

/* ---------- stand-ins (deleted as the real packages land) ---------- */

const CHANNELS: Record<ChipId, ChipProfileLike> = {
  adlib: profile(
    "AdLib",
    ["fm"],
    Array.from({ length: 9 }, (_, i) => ch(`fm${i + 1}`, "fm", 2))
  ),
  c64: profile(
    "C64",
    ["sid"],
    [1, 2, 3].map((i) => ch(`voice${i}`, "sid"))
  ),
  custom: profile(
    "Custom",
    ["pulse", "triangle", "noise", "wave", "sid", "fm", "sample"],
    [ch("pulse1", "pulse"), ch("pulse2", "pulse"), ch("noise", "noise")]
  ),
  gameboy: profile(
    "Game Boy",
    ["pulse", "wave", "noise"],
    [
      ch("pulse1", "pulse"),
      ch("pulse2", "pulse"),
      ch("wave", "wave"),
      ch("noise", "noise"),
    ]
  ),
  genesis: profile(
    "Genesis",
    ["fm", "pulse", "noise"],
    [
      ...Array.from({ length: 6 }, (_, i) => ch(`fm${i + 1}`, "fm", 4)),
      ...[1, 2, 3].map((i) => ch(`psg${i}`, "pulse")),
      ch("psgNoise", "noise"),
    ]
  ),
  nes: profile(
    "NES",
    ["pulse", "triangle", "noise"],
    [
      ch("pulse1", "pulse"),
      ch("pulse2", "pulse"),
      ch("triangle", "triangle"),
      ch("noise", "noise"),
    ]
  ),
  snes: profile(
    "SNES",
    ["sample"],
    Array.from({ length: 8 }, (_, i) => ch(`ch${i + 1}`, "sample"))
  ),
};

function ch(id: string, kind: ChannelKind, fmOps?: 2 | 4) {
  return fmOps ? { fmOps, id, kind, label: id } : { id, kind, label: id };
}

function profile(
  label: string,
  kinds: ChannelKind[],
  channels: ChipProfileLike["channels"]
): ChipProfileLike {
  return { channels, kinds, label };
}

const passThrough =
  <T>() =>
  (input: unknown): Normalized<T> => ({
    issues: [],
    ok: true,
    value: input as T,
  });

function stubDefaultProject(name = "Untitled"): Project {
  return {
    chip: "nes",
    export: {
      baseUrl: "/audio/",
      dir: "../public/audio",
      embed: false,
      events: true,
      manifest: "../src/audio.ts",
      mp3Bitrate: 160,
      musicFormat: "ogg",
      oggQuality: 6,
      sfxFormat: "ogg",
    },
    master: { limiter: true, volume: 0.8 },
    name,
    sampleRate: 48_000,
    seed: 1,
    version: 1,
  };
}

function stubDefaultSfx(chip: ChipId = "nes"): Sfx {
  return {
    arpeggio: { rate: 0, steps: [] },
    bitcrush: { bits: null, rateDivide: 1 },
    category: "custom",
    chip,
    duty: { start: 0.5, sweep: 0 },
    envelope: { attack: 0, decay: 0.2, punch: 0, sustain: 0.1 },
    filter: {
      highpass: null,
      highpassSweep: 0,
      lowpass: null,
      lowpassSweep: 0,
      resonance: 0,
    },
    fm: null,
    frequency: { deltaSlide: 0, min: 0, slide: 0, start: 440 },
    name: "Sfx",
    noise: { mode: "long" },
    phaser: { offset: 0, sweep: 0 },
    repeat: { rate: 0 },
    seed: 1,
    table: null,
    version: 1,
    vibrato: { depth: 0, rate: 0 },
    volume: 0.7,
    wave: "square",
  };
}

function stubDefaultInstrument(kind: ChannelKind, chip?: ChipId): Instrument {
  return {
    chip: chip ?? null,
    envelope: { attack: 0, decay: 0.1, release: 0.05, sustain: 0.7 },
    finetune: 0,
    fm: null,
    kind,
    macros: {},
    name: "Instrument",
    noise: kind === "noise" ? { mode: "long" } : null,
    pan: 0,
    pulse: kind === "pulse" ? { duty: 0.5 } : null,
    sample: null,
    send: { echo: 0, reverb: 0 },
    sid: null,
    transpose: 0,
    version: 1,
    volume: 0.8,
    wave: null,
  };
}

function stubDefaultSong(chip: ChipId = "nes"): Song {
  const profileForChip = CHANNELS[chip];
  return {
    channels: profileForChip.channels.map((c) => ({
      id: c.id,
      instrument: null,
      kind: c.kind,
      mml: null,
      muted: false,
      pan: 0,
      volume: 1,
    })),
    chip,
    loop: 0,
    master: { echo: null, reverb: null, volume: 0.8 },
    name: "Song",
    order: ["main"],
    patterns: { main: { length: 64, tracks: {} } },
    rowsPerBeat: 4,
    tempo: 120,
    tickRate: 60,
    version: 1,
  };
}

function stubRenderSfx(sfx: Sfx, opts: RenderOptions = {}): RenderResult {
  const rate = opts.sampleRate ?? 48_000;
  const seconds =
    sfx.envelope.attack + sfx.envelope.sustain + sfx.envelope.decay;
  const frames = Math.max(1, Math.round(seconds * rate));
  const left = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const fade = 1 - i / frames;
    left[i] =
      Math.sin((2 * Math.PI * sfx.frequency.start * i) / rate) *
      sfx.volume *
      0.5 *
      fade;
  }
  return {
    channels: [left, left.slice()],
    events: [],
    frames,
    sampleRate: rate,
  };
}

function stubRenderSong(
  song: Song,
  _instruments: Record<string, Instrument>,
  opts: RenderOptions = {}
): RenderResult {
  const rate = opts.sampleRate ?? 48_000;
  const frames = rate * 2;
  const left = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    left[i] = Math.sin((2 * Math.PI * 220 * i) / rate) * 0.25;
  }
  const events: EngineEvent[] = [
    {
      channel: 0,
      channelId: song.channels[0]?.id ?? "pulse1",
      frame: 0,
      hz: 220,
      id: "lead",
      note: 57,
      order: -1,
      row: -1,
      type: "noteOn",
      velocity: 1,
    },
  ];
  const result: RenderResult = {
    channels: [left, left.slice()],
    events,
    frames,
    sampleRate: rate,
  };
  if (song.loop !== null) {
    result.loopStart = Math.round(rate * 0.5);
    result.loopEnd = Math.round(rate * 1.5);
  }
  if (opts.stems) {
    result.stems = [left.slice()];
    result.stemIds = [song.channels[0]?.id ?? "pulse1"];
  }
  return result;
}

function stubEncodeWav(r: RenderResult): Uint8Array {
  const { frames } = r;
  const dataBytes = frames * 2 * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) {
      view.setUint8(o + i, s.charCodeAt(i));
    }
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  str(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, r.sampleRate, true);
  view.setUint32(28, r.sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, dataBytes, true);
  const [l] = r.channels;
  const rr = r.channels[1] ?? l;
  for (let i = 0; i < frames; i += 1) {
    view.setInt16(44 + i * 4, Math.round((l?.[i] ?? 0) * 32_767), true);
    view.setInt16(46 + i * 4, Math.round((rr?.[i] ?? 0) * 32_767), true);
  }
  return new Uint8Array(buf);
}

function stubDecodeWav(bytes: Uint8Array): RenderResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = view.getUint32(24, true);
  const frames = (bytes.byteLength - 44) / 4;
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    l[i] = view.getInt16(44 + i * 4, true) / 32_768;
    r[i] = view.getInt16(46 + i * 4, true) / 32_768;
  }
  return { channels: [l, r], events: [], frames, sampleRate };
}

function stubAnalyze(r: RenderResult, opts?: { file?: string }): AnalysisLike {
  let peak = 0;
  let sum = 0;
  const l = r.channels[0] ?? new Float32Array(0);
  for (const v of l) {
    peak = Math.max(peak, Math.abs(v));
    sum += v * v;
  }
  const rms = Math.sqrt(sum / Math.max(1, l.length));
  const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -120);
  return {
    channels: r.channels.length,
    clipped: { first: null, frames: 0 },
    crestDb: db(peak) - db(rms),
    dcOffset: 0,
    duration: r.frames / r.sampleRate,
    dutyCycle: null,
    envelope: [],
    file: opts?.file ?? "",
    frames: r.frames,
    leadingSilence: 0,
    loop: null,
    lufs: db(rms),
    peakDb: db(peak),
    pitch: { medianHz: null, medianNote: null, track: [] },
    rmsDb: db(rms),
    sampleRate: r.sampleRate,
    silenceDb: -120,
    spectrum: {
      bands: { highDb: -120, lowDb: -120, midDb: -120 },
      centroidHz: 0,
    },
    trailingSilence: 0,
  };
}

function missing(what: string): never {
  throw new Error(
    `${what} is not available yet (the engine package has not landed)`
  );
}

function stubGenerateSfx(
  category: SfxCategory,
  opts: { seed: number; chip?: ChipId; name?: string }
): Sfx {
  const base = stubDefaultSfx(opts.chip);
  base.category = category;
  base.seed = opts.seed;
  base.name = opts.name ?? category;
  base.frequency.start = 300 + (opts.seed % 900);
  return base;
}

function stubMutateSfx(sfx: Sfx, opts: { seed: number; amount?: number }): Sfx {
  const copy = structuredClone(sfx);
  copy.seed = opts.seed;
  copy.frequency.start = Math.min(
    8000,
    Math.max(20, copy.frequency.start * (1 + ((opts.seed % 100) - 50) / 400))
  );
  return copy;
}

function stubIssuesToText(issues: readonly Issue[]): string {
  return issues.map((i) => `${i.severity} ${i.path}: ${i.message}`).join("\n");
}

/* ---------- the facade ---------- */

export const chipProfile: CoreApi["chipProfile"] =
  realCore.chipProfile ?? ((id) => CHANNELS[id]);
export const defaultProject = realCore.defaultProject ?? stubDefaultProject;
export const defaultSfx = realCore.defaultSfx ?? stubDefaultSfx;
export const defaultInstrument =
  realCore.defaultInstrument ?? stubDefaultInstrument;
export const defaultSong = realCore.defaultSong ?? stubDefaultSong;
export const normalizeProject =
  realCore.normalizeProject ?? passThrough<Project>();
export const normalizeSfx = realCore.normalizeSfx ?? passThrough<Sfx>();
export const normalizeInstrument =
  realCore.normalizeInstrument ?? passThrough<Instrument>();
export const normalizeSong: CoreApi["normalizeSong"] =
  realCore.normalizeSong ?? passThrough<Song>();
export const issuesToText = realCore.issuesToText ?? stubIssuesToText;
export const parseMml: CoreApi["parseMml"] =
  realCore.parseMml ??
  (() => ({ events: [], issues: [], loopPulse: null, tempo: null }));
export const renderSfx = realCore.renderSfx ?? stubRenderSfx;
export const renderSong = realCore.renderSong ?? stubRenderSong;

export const encodeWav: ToolsApi["encodeWav"] =
  realTools.encodeWav ?? stubEncodeWav;
export const decodeWav = realTools.decodeWav ?? stubDecodeWav;
export const encodeOgg: ToolsApi["encodeOgg"] =
  realTools.encodeOgg ?? (() => missing("OGG encoding"));
export const encodeMp3: ToolsApi["encodeMp3"] =
  realTools.encodeMp3 ?? (() => missing("MP3 encoding"));
export const analyze = realTools.analyze ?? stubAnalyze;
export const encodePng: ToolsApi["encodePng"] =
  realTools.encodePng ?? (() => missing("PNG encoding"));
export const waveformImage: ToolsApi["waveformImage"] =
  realTools.waveformImage ?? (() => missing("waveform images"));
export const spectrogramImage: ToolsApi["spectrogramImage"] =
  realTools.spectrogramImage ?? (() => missing("spectrogram images"));
export const scopesImage: ToolsApi["scopesImage"] =
  realTools.scopesImage ?? (() => missing("scope images"));

export const generateSfx = realSfx.generateSfx ?? stubGenerateSfx;
export const mutateSfx = realSfx.mutateSfx ?? stubMutateSfx;
export const mutateMany: SfxApi["mutateMany"] =
  realSfx.mutateMany ??
  ((sfx, opts) =>
    Array.from({ length: opts.count }, (_, i) =>
      stubMutateSfx(sfx, { ...opts, seed: opts.seed + i })
    ));
export const describeSfx: SfxApi["describeSfx"] =
  realSfx.describeSfx ??
  ((sfx) =>
    `A ${sfx.category} sound on ${sfx.chip}: ${sfx.wave} at ${Math.round(sfx.frequency.start)} Hz.`);

/** Names of the engine pieces that are still stand-ins; empty once A, B and C have landed. */
export const STUBBED: string[] = [
  ["core.normalizeProject", realCore.normalizeProject],
  ["core.normalizeSfx", realCore.normalizeSfx],
  ["core.normalizeInstrument", realCore.normalizeInstrument],
  ["core.normalizeSong", realCore.normalizeSong],
  ["core.renderSfx", realCore.renderSfx],
  ["core.renderSong", realCore.renderSong],
  ["core.defaultSong", realCore.defaultSong],
  ["core.parseMml", realCore.parseMml],
  ["tools.encodeWav", realTools.encodeWav],
  ["tools.analyze", realTools.analyze],
  ["tools.encodeOgg", realTools.encodeOgg],
  ["tools.encodeMp3", realTools.encodeMp3],
  ["tools.encodePng", realTools.encodePng],
  ["sfx.generateSfx", realSfx.generateSfx],
]
  .filter(([, fn]) => typeof fn !== "function")
  .map(([name]) => String(name));
