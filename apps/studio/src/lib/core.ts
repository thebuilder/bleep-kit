/* The studio's view of @bleepkit/core, @bleepkit/core/tools and @bleepkit/sfx. Each function is the real one when its
   package exports it (the other streams land theirs while this one is built) and the small stand-in from
   src/dev/stub-core.ts until then, so the studio never waits for a sibling and never imports something that is missing. */
import * as realCore from "@bleepkit/core";
import * as realTools from "@bleepkit/core/tools";
import * as realSfx from "@bleepkit/sfx";
import * as stub from "../dev/stub-core.ts";
import type {
  ChannelKind,
  ChipChannel,
  ChipId,
  ChipProfile,
  Effect,
  Instrument,
  Issue,
  MmlEvent,
  Normalized,
  Project,
  RenderOptions,
  RenderResult,
  Row,
  Sfx,
  SfxCategory,
  Song,
} from "./contract.ts";

type Bag = Record<string, unknown>;
const core = realCore as unknown as Bag;
const tools = realTools as unknown as Bag;
const sfxPkg = realSfx as unknown as Bag;

function pick<T>(bag: Bag, name: string, fallback: T): T {
  const v = bag[name];
  return (typeof v === "function" ? v : fallback) as T;
}

/** Which parts are real, for the status line and the tests. */
export const realParts = {
  core: typeof core.normalizeSfx === "function",
  render: typeof core.renderSfx === "function",
  sfx: typeof sfxPkg.generateSfx === "function",
  tools: typeof tools.analyze === "function",
};

export const normalizeProject = pick<(i: unknown) => Normalized<Project>>(
  core,
  "normalizeProject",
  stub.stubNormalizeProject
);
export const normalizeSfx = pick<(i: unknown) => Normalized<Sfx>>(
  core,
  "normalizeSfx",
  stub.stubNormalizeSfx
);
export const normalizeInstrument = pick<(i: unknown) => Normalized<Instrument>>(
  core,
  "normalizeInstrument",
  stub.stubNormalizeInstrument
);
export const normalizeSong = pick<
  (i: unknown, instruments?: Record<string, Instrument>) => Normalized<Song>
>(core, "normalizeSong", stub.stubNormalizeSong);
export const defaultProject = pick<(name?: string) => Project>(
  core,
  "defaultProject",
  stub.defaultProject
);
export const defaultSfx = pick<(chip?: ChipId) => Sfx>(
  core,
  "defaultSfx",
  stub.defaultSfx
);
export const defaultInstrument = pick<
  (kind: ChannelKind, chip?: ChipId | null) => Instrument
>(core, "defaultInstrument", stub.defaultInstrument);
export const defaultSong = pick<(chip?: ChipId) => Song>(
  core,
  "defaultSong",
  stub.defaultSong
);
export const issuesToText = pick<(issues: readonly Issue[]) => string>(
  core,
  "issuesToText",
  (issues) =>
    issues.map((i) => `${i.severity} ${i.path}: ${i.message}`).join("\n")
);

export const noteToHz = pick<(note: number, cents?: number) => number>(
  core,
  "noteToHz",
  stub.noteToHz
);
export const hzToNote = pick<(hz: number) => number>(
  core,
  "hzToNote",
  stub.hzToNote
);
export const noteName = pick<(note: number) => string>(
  core,
  "noteName",
  stub.noteName
);
export const parseNoteName = pick<(s: string) => number | null>(
  core,
  "parseNoteName",
  stub.parseNoteName
);
export const parseEffect = pick<(code: string) => Effect | null>(
  core,
  "parseEffect",
  stub.parseEffect
);
export const formatEffect = pick<(e: Effect) => string>(
  core,
  "formatEffect",
  stub.formatEffect
);

export const parseMml = pick<
  (src: string) => {
    events: MmlEvent[];
    issues: Issue[];
    loopPulse: number | null;
    tempo: number | null;
  }
>(core, "parseMml", stub.stubParseMml);
export const mmlToTrack = pick<
  (
    src: string,
    rowsPerBeat: number
  ) => { rows: Row[]; issues: Issue[]; loopRow: number | null }
>(core, "mmlToTrack", stub.stubMmlToTrack);
export const patternToMml = pick<
  (rows: readonly Row[], rowsPerBeat: number) => string
>(core, "patternToMml", stub.stubPatternToMml);

export const chipProfile = pick<(id: ChipId) => ChipProfile>(
  core,
  "chipProfile",
  stub.stubChipProfile
);
export const chipChannels = pick<(song: Song) => readonly ChipChannel[]>(
  core,
  "chipChannels",
  stub.stubChipChannels
);

export const renderSfx = pick<(sfx: Sfx, opts?: RenderOptions) => RenderResult>(
  core,
  "renderSfx",
  stub.stubRenderSfx
);
export const renderSong = pick<
  (
    song: Song,
    instruments: Record<string, Instrument>,
    opts?: RenderOptions
  ) => RenderResult
>(core, "renderSong", stub.stubRenderSong);
export const renderInstrumentNote = pick<
  (
    inst: Instrument,
    note: number,
    opts?: RenderOptions & {
      chip?: ChipId;
      duration?: number;
      release?: number;
    }
  ) => RenderResult
>(core, "renderInstrumentNote", stub.stubRenderInstrumentNote);

export interface SampleParamSpec {
  default: number;
  label: string;
  max: number;
  min: number;
}
export interface SampleGeneratorSpec {
  id: string;
  label: string;
  loops: boolean;
  params: Record<string, SampleParamSpec>;
}
const FALLBACK_GENS: Record<string, SampleGeneratorSpec> = Object.fromEntries(
  [
    "kick",
    "snare",
    "hat",
    "tom",
    "clap",
    "crash",
    "pluck",
    "bass",
    "pad",
    "organ",
    "bell",
    "strings",
    "choir",
    "lead",
  ].map((id) => [
    id,
    {
      id,
      label: id[0]?.toUpperCase() + id.slice(1),
      loops: ["pad", "organ", "strings", "choir", "lead", "bass"].includes(id),
      params: {
        brightness: { default: 0.5, label: "Brightness", max: 1, min: 0 },
        damp: { default: 0.3, label: "Damping", max: 1, min: 0 },
      },
    },
  ])
);
export const SAMPLE_GENERATORS: Record<string, SampleGeneratorSpec> =
  (core.SAMPLE_GENERATORS as Record<string, SampleGeneratorSpec> | undefined) ??
  FALLBACK_GENS;
export const generateSample = pick<
  (
    gen: string,
    params: Record<string, number>,
    seed: number,
    sampleRate: number
  ) => {
    data: Float32Array;
    sampleRate: number;
    baseNote: number;
    loopStart: number | null;
    loopEnd: number | null;
  }
>(core, "generateSample", (gen, params, seed, sampleRate) => {
  const n = Math.floor(sampleRate * 0.6);
  const data = new Float32Array(n);
  const r = stub.mulberry32(seed + stub.hashString(gen));
  const hz = 220 * (1 + (params.brightness ?? 0.5));
  const noisy = ["snare", "hat", "clap", "crash"].includes(gen);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t * (6 + (params.damp ?? 0.3) * 10));
    data[i] =
      (noisy
        ? r() * 2 - 1
        : Math.sin(
            2 * Math.PI * hz * t * (gen === "kick" ? Math.exp(-t * 8) + 0.3 : 1)
          )) *
      env *
      0.8;
  }
  return { baseNote: 60, data, loopEnd: null, loopStart: null, sampleRate };
});

export const mulberry32 = pick<(seed: number) => () => number>(
  core,
  "mulberry32",
  stub.mulberry32
);
export const hashString = pick<(s: string) => number>(
  core,
  "hashString",
  stub.hashString
);

export const generateSfx = pick<
  (
    category: SfxCategory,
    opts: { seed: number; chip?: ChipId; name?: string }
  ) => Sfx
>(sfxPkg, "generateSfx", stub.stubGenerateSfx);
export const randomizeSfx = pick<(sfx: Sfx, seed: number) => Sfx>(
  sfxPkg,
  "randomizeSfx",
  stub.stubRandomizeSfx
);
export const mutateSfx = pick<
  (sfx: Sfx, opts: { seed: number; amount?: number }) => Sfx
>(sfxPkg, "mutateSfx", stub.stubMutateSfx);
export const mutateMany = pick<
  (sfx: Sfx, opts: { seed: number; amount?: number; count: number }) => Sfx[]
>(sfxPkg, "mutateMany", stub.stubMutateMany);
export const describeSfx = pick<(sfx: Sfx) => string>(
  sfxPkg,
  "describeSfx",
  stub.stubDescribeSfx
);

export type Analysis = stub.StubAnalysis;
export const analyze = pick<
  (r: RenderResult, opts?: Record<string, unknown>) => Analysis
>(tools, "analyze", (r) => stub.stubAnalyze(r));
export const encodeWav = tools.encodeWav as
  | ((r: RenderResult, opts?: Record<string, unknown>) => Uint8Array)
  | undefined;
export const realFft = tools.fft as
  | ((...args: unknown[]) => unknown)
  | undefined;

export interface PixelImage {
  data: Uint8Array;
  height: number;
  width: number;
}
type ImageFn = (
  r: RenderResult,
  opts?: { width?: number; height?: number; title?: string }
) => PixelImage;
export const waveformImage = tools.waveformImage as ImageFn | undefined;
export const spectrogramImage = tools.spectrogramImage as ImageFn | undefined;
export const scopesImage = tools.scopesImage as ImageFn | undefined;
export const encodeOgg = tools.encodeOgg as
  | ((r: RenderResult, opts?: { quality?: number }) => Promise<Uint8Array>)
  | undefined;
export const encodeMp3 = tools.encodeMp3 as
  | ((r: RenderResult, opts?: { bitrate?: number }) => Promise<Uint8Array>)
  | undefined;
export const MP3_ENCODER_DELAY =
  (tools.MP3_ENCODER_DELAY as number | undefined) ?? 1105;
