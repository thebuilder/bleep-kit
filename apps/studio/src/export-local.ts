/* Exporting when there is no studio server: render every sound in the browser, encode it, build the manifest and
   zip the lot, laid out like the game project (public/audio/..., src/audio.ts). With a server, the CLI's export does this. */
import { encodeAudio } from "./encode-service.ts";
import {
  cleanPath,
  type Manifest,
  manifestJson,
  manifestTs,
  type SfxEntry,
  type SongEntry,
} from "./export-preview.ts";
import type { Instrument, Project, Sfx, Song } from "./lib/contract.ts";
import { MP3_ENCODER_DELAY } from "./lib/core.ts";
import { renderSfxAsync, renderSongAsync } from "./render-service.ts";
import { project } from "./state/docs.ts";
import { writeZip, type ZipEntry } from "./zip.ts";

export interface ExportResult {
  bytes: number;
  entries: ZipEntry[];
  manifest: Manifest;
  notes: string[];
  zip: Uint8Array;
}

const enc = new TextEncoder();
const round = (n: number) => Math.round(n * 1000) / 1000;

interface ExportCtx {
  dir: string;
  entries: ZipEntry[];
  instruments: Record<string, Instrument>;
  manifest: Manifest;
  notes: string[];
  project: Project;
}

const putEntry = (
  ctx: ExportCtx,
  path: string,
  data: Uint8Array | string
): void => {
  ctx.entries.push({
    data: typeof data === "string" ? enc.encode(data) : data,
    path,
  });
};

type Rendered = Awaited<ReturnType<typeof renderSfxAsync>>;

/** Encode a render in the project's format and add the file to the zip; returns the file name and the format used. */
async function encodeEntry(
  ctx: ExportCtx,
  id: string,
  r: Rendered,
  format: Project["export"]["sfxFormat"]
): Promise<{ file: string; used: string }> {
  const out = await encodeAudio(r, {
    bitrate: ctx.project.export.mp3Bitrate,
    format,
    name: id,
    quality: ctx.project.export.oggQuality,
  });
  if (out.note) {
    ctx.notes.push(`${id}: ${out.note}`);
  }
  const file = `${id}.${out.used}`;
  putEntry(ctx, `${ctx.dir}/${file}`, out.bytes);
  return { file, used: out.used };
}

async function exportSfx(ctx: ExportCtx, d: { id: string; value: unknown }) {
  const r = await renderSfxAsync(d.value as Sfx, ctx.project.sampleRate);
  const { file } = await encodeEntry(
    ctx,
    d.id,
    r,
    ctx.project.export.sfxFormat
  );
  const e: SfxEntry = { duration: round(r.frames / r.sampleRate), file };
  if (ctx.project.export.embed) {
    e.data = d.value as Sfx;
  }
  ctx.manifest.sfx[d.id] = e;
}

/** Loop points in seconds. An MP3 starts late by the encoder delay, so its points shift by the same amount. */
function loopPoints(r: Rendered, used: string) {
  const shift = used === "mp3" ? MP3_ENCODER_DELAY / r.sampleRate : 0;
  const point = (frames: number | undefined) =>
    frames === undefined ? null : round(frames / r.sampleRate + shift);
  return { loopEnd: point(r.loopEnd), loopStart: point(r.loopStart) };
}

async function exportSong(ctx: ExportCtx, d: { id: string; value: unknown }) {
  const p = ctx.project;
  const r = await renderSongAsync(
    d.value as Song,
    ctx.instruments,
    p.sampleRate
  );
  const { file, used } = await encodeEntry(ctx, d.id, r, p.export.musicFormat);
  const e: SongEntry = {
    duration: round(r.frames / r.sampleRate),
    file,
    ...loopPoints(r, used),
  };
  if (used === "mp3" && e.loopStart !== null) {
    ctx.notes.push(
      "MP3 loop points are approximate; use OGG for seamless loops"
    );
  }
  if (p.export.events) {
    const evName = `${d.id}.events.json`;
    putEntry(ctx, `${ctx.dir}/${evName}`, JSON.stringify(r.events));
    e.events = evName;
  }
  if (p.export.embed) {
    e.data = { instruments: ctx.instruments, song: d.value as Song };
  }
  ctx.manifest.songs[d.id] = e;
}

export async function exportInBrowser(
  onProgress: (done: number, total: number, label: string) => void
): Promise<ExportResult> {
  const p = project.project;
  const sfx = project.list("sfx");
  const songs = project.list("song");
  const total = sfx.length + songs.length;
  const ctx: ExportCtx = {
    dir: cleanPath(p.export.dir),
    entries: [],
    instruments: project.instruments() as Record<string, Instrument>,
    manifest: {
      base: p.export.baseUrl,
      sampleRate: p.sampleRate,
      sfx: {},
      songs: {},
    },
    notes: [],
    project: p,
  };
  let done = 0;
  for (const d of sfx) {
    onProgress(done, total, `sfx/${d.id}`);
    // biome-ignore lint/performance/noAwaitInLoops: one file at a time on purpose, the progress bar names each file and only one rendered buffer is alive at once
    await exportSfx(ctx, d);
    done += 1;
  }
  for (const d of songs) {
    onProgress(done, total, `song/${d.id}`);
    // biome-ignore lint/performance/noAwaitInLoops: one file at a time on purpose, see the sfx loop above
    await exportSong(ctx, d);
    done += 1;
  }
  onProgress(total, total, "manifest");
  putEntry(ctx, `${ctx.dir}/manifest.json`, manifestJson(ctx.manifest));
  putEntry(ctx, cleanPath(p.export.manifest), manifestTs(ctx.manifest));
  const zip = writeZip(ctx.entries);
  return {
    bytes: zip.length,
    entries: ctx.entries,
    manifest: ctx.manifest,
    notes: [...new Set(ctx.notes)],
    zip,
  };
}

export function download(
  name: string,
  bytes: Uint8Array | string,
  type = "application/zip"
): void {
  const blob = new Blob(
    [typeof bytes === "string" ? bytes : (bytes as unknown as BlobPart)],
    { type }
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
