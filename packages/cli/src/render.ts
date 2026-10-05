// The render pipeline shared by `render`, `analyze`, `export` and the studio server: render a document through the
// engine, write the master WAV plus sidecars into out/, and skip the work when the hash sidecar says the render is
// still fresh (architecture.md 6.2 "Staleness").
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { CliError, round } from "./output.ts";
import {
  type DocKind,
  instrumentsFor,
  KIND_DIRS,
  loadDoc,
  type ProjectCtx,
  requireOk,
  sha1Hex,
  stableStringify,
  writeFileAtomic,
} from "./project.ts";
import {
  type AnalysisLike,
  analyze,
  decodeWav,
  encodeMp3,
  encodeOgg,
  encodePng,
  encodeWav,
  type RenderResult,
  renderSfx,
  renderSong,
  type Sfx,
  type Song,
  scopesImage,
  spectrogramImage,
  waveformImage,
} from "./stubs.ts";

/** Bump when the pipeline's output changes for the same inputs (invalidates every sidecar hash). */
const PIPELINE_VERSION = 1;

/** Frames of silence an MP3 encoder adds at the start (LAME style); wasm-media-encoders does not report it. */
export const MP3_ENCODER_DELAY_FRAMES = 1105;

export type AudioFormat = "wav" | "ogg" | "mp3";

export interface RenderOpts {
  analyze?: boolean;
  /** Render even when the sidecar says the render is fresh. */
  force?: boolean;
  /** Also write this format next to the WAV master (wav means master only). */
  format?: AudioFormat;
  images?: boolean;
  loops?: number;
  /** Keep the whole pitch track instead of trimming it to 200 entries. */
  pitch?: boolean;
  rate?: number;
  stems?: boolean;
  tail?: number;
  /** Pitch tracker window in frames. */
  window?: number;
}

export interface Meta {
  clipped: boolean;
  clippedFrames: number;
  duration: number;
  /** Per encoded format: hash of (render hash, encoder setting) of the file currently on disk. */
  exports: Record<string, string>;
  formats: Record<string, string>;
  frames: number;
  hash: string;
  loopEnd: number | null;
  loopStart: number | null;
  peakDb: number;
  rate: number;
  rmsDb: number;
  version: number;
}

export interface RenderEntry {
  analysis?: AnalysisLike;
  /** True when the sidecar hash matched and nothing was re-rendered. */
  cached: boolean;
  clipped: boolean;
  clippedFrames: number;
  duration: number;
  /** Absolute path of `path`. */
  file: string;
  /** Every file this render wrote or kept (project relative). */
  files: string[];
  images?: { scopes?: string; spectrogram: string; waveform: string };
  loopEnd: number | null;
  loopStart: number | null;
  /** The WAV master, project relative. */
  master: string;
  ok: true;
  /** The requested format's file, project relative (the master when the format is wav). */
  path: string;
  peakDb: number;
  rate: number;
  ref: string;
  rmsDb: number;
  stems?: string[];
}

/* ---------- paths ---------- */

export function outBase(kind: DocKind, id: string): string {
  return `out/${KIND_DIRS[kind]}/${id}`;
}

export function metaRel(kind: DocKind, id: string): string {
  return `${outBase(kind, id)}.meta.json`;
}

export function readMeta(
  pc: ProjectCtx,
  kind: DocKind,
  id: string
): Meta | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(pc.root, metaRel(kind, id)), "utf8")
    ) as Partial<Meta>;
    if (typeof raw.hash !== "string") {
      return null;
    }
    return {
      clipped: raw.clipped ?? false,
      clippedFrames: raw.clippedFrames ?? 0,
      duration: raw.duration ?? 0,
      exports: raw.exports ?? {},
      formats: raw.formats ?? {},
      frames: raw.frames ?? 0,
      hash: raw.hash,
      loopEnd: raw.loopEnd ?? null,
      loopStart: raw.loopStart ?? null,
      peakDb: raw.peakDb ?? Number.NEGATIVE_INFINITY,
      rate: raw.rate ?? 0,
      rmsDb: raw.rmsDb ?? Number.NEGATIVE_INFINITY,
      version: raw.version ?? 0,
    };
  } catch {
    return null;
  }
}

function writeMeta(
  pc: ProjectCtx,
  kind: DocKind,
  id: string,
  meta: Meta
): void {
  // -Infinity is not JSON: store a floor value instead
  const floor = (v: number) => (Number.isFinite(v) ? v : -200);
  writeFileAtomic(
    path.join(pc.root, metaRel(kind, id)),
    `${JSON.stringify({ ...meta, peakDb: floor(meta.peakDb), rmsDb: floor(meta.rmsDb) }, null, 2)}\n`
  );
}

/* ---------- effective options and the hash ---------- */

export interface Effective {
  loops: number;
  rate: number;
  seed: number;
  tail: number;
}

export function effective(
  pc: ProjectCtx,
  kind: DocKind,
  opts: RenderOpts
): Effective {
  const rate = opts.rate ?? pc.project.sampleRate;
  if (!(Number.isFinite(rate) && rate >= 22_050 && rate <= 96_000)) {
    throw new CliError("usage", `--rate must be 22050 to 96000 (got ${rate})`, {
      hint: "Use 44100 or 48000.",
    });
  }
  const loops = opts.loops ?? 1;
  if (!(Number.isInteger(loops) && loops >= 1 && loops <= 64)) {
    throw new CliError(
      "usage",
      `--loops must be a whole number from 1 to 64 (got ${loops})`
    );
  }
  const tail = opts.tail ?? (kind === "sfx" ? 0.25 : 1);
  if (!(tail >= 0 && tail <= 30)) {
    throw new CliError("usage", `--tail must be 0 to 30 seconds (got ${tail})`);
  }
  return { loops: kind === "song" ? loops : 1, rate, seed: pc.seed, tail };
}

export function renderHash(
  pc: ProjectCtx,
  kind: DocKind,
  value: Sfx | Song,
  eff: Effective
): string {
  const instruments = kind === "song" ? instrumentsFor(pc, value as Song) : {};
  return sha1Hex(
    stableStringify({
      doc: value,
      eff,
      instruments,
      kind,
      master: pc.project.master,
      v: PIPELINE_VERSION,
    })
  );
}

export type Freshness = "fresh" | "stale" | "missing";

/** Cheap check used by list, analyze and export --dry-run: hash compare plus the master file's existence. */
export function freshness(
  pc: ProjectCtx,
  kind: DocKind,
  id: string,
  opts: RenderOpts = {}
): Freshness {
  const doc = loadDoc(pc, kind, id);
  if (kind === "instrument") {
    return "missing";
  }
  const meta = readMeta(pc, kind, id);
  const wav = path.join(pc.root, `${outBase(kind, id)}.wav`);
  if (!(meta && fs.existsSync(wav))) {
    return "missing";
  }
  const eff = effective(pc, kind, opts);
  return meta.hash === renderHash(pc, kind, doc.value as Sfx | Song, eff)
    ? "fresh"
    : "stale";
}

/* ---------- levels ---------- */

export function levels(r: RenderResult): {
  clipped: boolean;
  clippedFrames: number;
  peakDb: number;
  rmsDb: number;
} {
  let peak = 0;
  let sum = 0;
  let count = 0;
  let clippedFrames = 0;
  for (let i = 0; i < r.frames; i += 1) {
    let frameClipped = false;
    for (const ch of r.channels) {
      const v = Math.abs(ch[i] ?? 0);
      peak = Math.max(peak, v);
      sum += v * v;
      count += 1;
      if (v >= 0.999) {
        frameClipped = true;
      }
    }
    if (frameClipped) {
      clippedFrames += 1;
    }
  }
  const db = (x: number) =>
    x > 0 ? 20 * Math.log10(x) : Number.NEGATIVE_INFINITY;
  return {
    clipped: clippedFrames > 0,
    clippedFrames,
    peakDb: round(db(peak), 2),
    rmsDb: round(db(Math.sqrt(sum / Math.max(1, count))), 2),
  };
}

/* ---------- events file ---------- */

export function eventsJson(r: RenderResult): string {
  return `${JSON.stringify({
    duration: round(r.frames / r.sampleRate, 6),
    events: r.events,
    loopEnd:
      r.loopEnd === undefined ? null : round(r.loopEnd / r.sampleRate, 6),
    loopStart:
      r.loopStart === undefined ? null : round(r.loopStart / r.sampleRate, 6),
    sampleRate: r.sampleRate,
  })}\n`;
}

/* ---------- the pipeline ---------- */

export interface RenderContext {
  /** Progress line sink (stderr in the CLI). */
  log?: (text: string) => void;
}

function encodeFailure(format: string, error: unknown): CliError {
  return new CliError(
    "encode",
    `${format} encoding failed: ${(error as Error).message}`,
    {
      hint: `Render with --format wav, or set export.sfxFormat and export.musicFormat to "wav" in project.json (the ${format} encoder is WASM and needs a working node_modules).`,
    }
  );
}

export async function encodeAs(
  pc: ProjectCtx,
  r: RenderResult,
  format: AudioFormat
): Promise<Uint8Array> {
  try {
    if (format === "wav") {
      return encodeWav(r);
    }
    if (format === "ogg") {
      return await encodeOgg(r, { quality: pc.project.export.oggQuality });
    }
    return await encodeMp3(r, { bitrate: pc.project.export.mp3Bitrate });
  } catch (error) {
    throw encodeFailure(format, error);
  }
}

export function encoderSetting(pc: ProjectCtx, format: AudioFormat): string {
  if (format === "ogg") {
    return `ogg:${pc.project.export.oggQuality}`;
  }
  if (format === "mp3") {
    return `mp3:${pc.project.export.mp3Bitrate}`;
  }
  return "wav";
}

function readMaster(pc: ProjectCtx, rel: string): RenderResult {
  try {
    return decodeWav(new Uint8Array(fs.readFileSync(path.join(pc.root, rel))));
  } catch (error) {
    throw new CliError(
      "invalid",
      `cannot read the render ${rel}: ${(error as Error).message}`,
      {
        cause: error,
        hint: "Delete the out/ folder or re-run `bleepkit render --force`.",
      }
    );
  }
}

function doRender(
  pc: ProjectCtx,
  kind: DocKind,
  doc: { id: string; value: unknown },
  eff: Effective,
  wantStems: boolean
): RenderResult {
  const options = {
    loops: eff.loops,
    sampleRate: eff.rate,
    seed: eff.seed,
    stems: wantStems,
    tail: eff.tail,
  };
  try {
    if (kind === "sfx") {
      return renderSfx(doc.value as Sfx, options);
    }
    const song = doc.value as Song;
    return renderSong(song, instrumentsFor(pc, song), options);
  } catch (error) {
    throw new CliError(
      "invalid",
      `rendering ${kind}/${doc.id} failed: ${(error as Error).message}`,
      {
        cause: error,
        hint: `Run \`bleepkit validate ${kind}/${doc.id}\` and check the document for impossible values.`,
      }
    );
  }
}

function writeImages(
  pc: ProjectCtx,
  id: string,
  r: RenderResult
): { scopes?: string; spectrogram: string; waveform: string } {
  const deflate = (d: Uint8Array) => new Uint8Array(zlib.deflateSync(d));
  const base = `out/analysis/${id}`;
  const write = (suffix: string, img: Parameters<typeof encodePng>[0]) => {
    const rel = `${base}.${suffix}.png`;
    writeFileAtomic(path.join(pc.root, rel), encodePng(img, deflate));
    return rel;
  };
  const images: { scopes?: string; spectrogram: string; waveform: string } = {
    spectrogram: write("spectrogram", spectrogramImage(r)),
    waveform: write("waveform", waveformImage(r)),
  };
  if (r.stems && r.stems.length > 0) {
    images.scopes = write("scopes", scopesImage(r));
  }
  return images;
}

interface Job {
  base: string;
  eff: Effective;
  hash: string;
  id: string;
  kind: "sfx" | "song";
  masterRel: string;
  opts: RenderOpts;
  pc: ProjectCtx;
}

interface Produced {
  cached: boolean;
  files: string[];
  meta: Meta;
  result: RenderResult | null;
}

function metaOf(job: Job, result: RenderResult): Meta {
  const sec = (frames: number | undefined) =>
    frames === undefined ? null : round(frames / result.sampleRate, 6);
  return {
    ...levels(result),
    duration: round(result.frames / result.sampleRate, 6),
    exports: {},
    formats: {},
    frames: result.frames,
    hash: job.hash,
    loopEnd: sec(result.loopEnd),
    loopStart: sec(result.loopStart),
    rate: result.sampleRate,
    version: PIPELINE_VERSION,
  };
}

/** Renders and writes the master (and events) unless the sidecar says the existing render is current. */
function produce(
  job: Job,
  doc: { id: string; value: unknown },
  rc: RenderContext
): Produced {
  const { pc, kind, id, opts } = job;
  const prior = readMeta(pc, kind, id);
  const needsStems =
    Boolean(opts.stems) || (Boolean(opts.images) && kind === "song");
  const reusable =
    !(opts.force || needsStems) &&
    prior?.hash === job.hash &&
    fs.existsSync(path.join(pc.root, job.masterRel));
  if (reusable && prior) {
    return { cached: true, files: [job.masterRel], meta: prior, result: null };
  }
  rc.log?.(`rendering ${kind}/${id} ...`);
  const result = doRender(pc, kind, doc, job.eff, needsStems);
  const files = [job.masterRel];
  writeFileAtomic(path.join(pc.root, job.masterRel), encodeWav(result));
  if (kind === "song") {
    const eventsRel = `${job.base}.events.json`;
    writeFileAtomic(path.join(pc.root, eventsRel), eventsJson(result));
    files.push(eventsRel);
  }
  const meta = metaOf(job, result);
  writeMeta(pc, kind, id, meta);
  return { cached: false, files, meta, result };
}

/** Writes the ogg or mp3 next to the master when it is missing or was encoded from another render. */
async function encodeExtra(
  job: Job,
  produced: Produced,
  format: AudioFormat
): Promise<string> {
  const { pc, kind, id } = job;
  const rel = `${job.base}.${format}`;
  const setting = sha1Hex(`${job.hash}:${encoderSetting(pc, format)}`);
  if (
    produced.meta.formats[format] !== setting ||
    !fs.existsSync(path.join(pc.root, rel))
  ) {
    produced.result ??= readMaster(pc, job.masterRel);
    writeFileAtomic(
      path.join(pc.root, rel),
      await encodeAs(pc, produced.result, format)
    );
    produced.meta.formats[format] = setting;
    writeMeta(pc, kind, id, produced.meta);
  }
  return rel;
}

function writeStems(job: Job, result: RenderResult): string[] {
  const stems: string[] = [];
  (result.stems ?? []).forEach((stem, i) => {
    const rel = `${job.base}.stem-${result.stemIds?.[i] ?? `ch${i + 1}`}.wav`;
    const mono: RenderResult = {
      channels: [stem, stem],
      events: [],
      frames: stem.length,
      sampleRate: result.sampleRate,
    };
    writeFileAtomic(path.join(job.pc.root, rel), encodeWav(mono));
    stems.push(rel);
  });
  return stems;
}

function analysisOf(job: Job, result: RenderResult): AnalysisLike {
  const analysis = analyze(result, {
    file: job.masterRel,
    maxTrack: job.opts.pitch ? Number.POSITIVE_INFINITY : 200,
    ...(job.opts.window ? { pitchWindow: job.opts.window } : {}),
  });
  analysis.file = job.masterRel;
  return analysis;
}

export async function renderDoc(
  pc: ProjectCtx,
  kind: "sfx" | "song",
  id: string,
  opts: RenderOpts = {},
  rc: RenderContext = {}
): Promise<RenderEntry> {
  const doc = loadDoc(pc, kind, id);
  requireOk(doc);
  const eff = effective(pc, kind, opts);
  const base = outBase(kind, id);
  const job: Job = {
    base,
    eff,
    hash: renderHash(pc, kind, doc.value as Sfx | Song, eff),
    id,
    kind,
    masterRel: `${base}.wav`,
    opts,
    pc,
  };
  const produced = produce(job, doc, rc);
  const { meta } = produced;
  const files = [...produced.files];
  const format = opts.format ?? "wav";
  const mainRel =
    format === "wav" ? job.masterRel : await encodeExtra(job, produced, format);
  if (format !== "wav") {
    files.push(mainRel);
  }
  const entry: RenderEntry = {
    cached: produced.cached,
    clipped: meta.clipped,
    clippedFrames: meta.clippedFrames,
    duration: meta.duration,
    file: path.join(pc.root, mainRel),
    files,
    loopEnd: meta.loopEnd,
    loopStart: meta.loopStart,
    master: job.masterRel,
    ok: true,
    path: mainRel,
    peakDb: meta.peakDb,
    rate: meta.rate,
    ref: `${kind}/${id}`,
    rmsDb: meta.rmsDb,
  };
  if (opts.stems && produced.result?.stems) {
    entry.stems = writeStems(job, produced.result);
    files.push(...entry.stems);
  }
  if (opts.analyze || opts.images) {
    const result = produced.result ?? readMaster(pc, job.masterRel);
    if (opts.analyze) {
      entry.analysis = analysisOf(job, readMaster(pc, job.masterRel));
    }
    if (opts.images) {
      entry.images = writeImages(pc, id, result);
      files.push(...Object.values(entry.images));
      if (entry.analysis) {
        entry.analysis.images = entry.images;
      }
    }
  }
  return entry;
}

/** Remembers that the file at `key` was encoded from the render with hash `value`. */
export function recordExport(
  pc: ProjectCtx,
  kind: DocKind,
  id: string,
  key: string,
  value: string
): void {
  const meta = readMeta(pc, kind, id);
  if (!meta) {
    return;
  }
  meta.exports[key] = value;
  writeMeta(pc, kind, id, meta);
}
