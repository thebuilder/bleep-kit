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
import type { Instrument, Sfx, Song } from "./lib/contract.ts";
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

export async function exportInBrowser(
  onProgress: (done: number, total: number, label: string) => void
): Promise<ExportResult> {
  const p = project.project;
  const sfx = project.list("sfx");
  const songs = project.list("song");
  const instruments = project.instruments();
  const total = sfx.length + songs.length;
  const dir = cleanPath(p.export.dir);
  const entries: ZipEntry[] = [];
  const notes: string[] = [];
  const manifest: Manifest = {
    base: p.export.baseUrl,
    sampleRate: p.sampleRate,
    sfx: {},
    songs: {},
  };
  let done = 0;
  const put = (path: string, data: Uint8Array | string) =>
    entries.push({
      data: typeof data === "string" ? enc.encode(data) : data,
      path,
    });
  const fileName = (id: string, used: string) => `${id}.${used}`;

  for (const d of sfx) {
    onProgress(done, total, `sfx/${d.id}`);
    const r = await renderSfxAsync(d.value as Sfx, p.sampleRate);
    const out = await encodeAudio(r, {
      bitrate: p.export.mp3Bitrate,
      format: p.export.sfxFormat,
      name: d.id,
      quality: p.export.oggQuality,
    });
    if (out.note) {
      notes.push(`${d.id}: ${out.note}`);
    }
    const file = fileName(d.id, out.used);
    put(`${dir}/${file}`, out.bytes);
    const e: SfxEntry = { duration: round(r.frames / r.sampleRate), file };
    if (p.export.embed) {
      e.data = d.value as Sfx;
    }
    manifest.sfx[d.id] = e;
    done++;
  }
  for (const d of songs) {
    onProgress(done, total, `song/${d.id}`);
    const r = await renderSongAsync(
      d.value as Song,
      instruments as Record<string, Instrument>,
      p.sampleRate
    );
    const out = await encodeAudio(r, {
      bitrate: p.export.mp3Bitrate,
      format: p.export.musicFormat,
      name: d.id,
      quality: p.export.oggQuality,
    });
    if (out.note) {
      notes.push(`${d.id}: ${out.note}`);
    }
    const file = fileName(d.id, out.used);
    put(`${dir}/${file}`, out.bytes);
    const shift = out.used === "mp3" ? MP3_ENCODER_DELAY / r.sampleRate : 0;
    const e: SongEntry = {
      duration: round(r.frames / r.sampleRate - (out.used === "mp3" ? 0 : 0)),
      file,
      loopEnd:
        r.loopEnd === undefined
          ? null
          : round(r.loopEnd / r.sampleRate + shift),
      loopStart:
        r.loopStart === undefined
          ? null
          : round(r.loopStart / r.sampleRate + shift),
    };
    if (out.used === "mp3" && e.loopStart !== null) {
      notes.push("MP3 loop points are approximate; use OGG for seamless loops");
    }
    if (p.export.events) {
      const evName = `${d.id}.events.json`;
      put(`${dir}/${evName}`, JSON.stringify(r.events));
      e.events = evName;
    }
    if (p.export.embed) {
      e.data = {
        instruments: instruments as Record<string, Instrument>,
        song: d.value as Song,
      };
    }
    manifest.songs[d.id] = e;
    done++;
  }
  onProgress(total, total, "manifest");
  put(`${dir}/manifest.json`, manifestJson(manifest));
  put(cleanPath(p.export.manifest), manifestTs(manifest));
  const zip = writeZip(entries);
  return {
    bytes: zip.length,
    entries,
    manifest,
    notes: [...new Set(notes)],
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
