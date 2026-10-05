/* Loading and reading manifests (section 7) and the OGG support probe (section 8). */

import type { AudioManifest, ManifestSfx, ManifestSong } from "./types.ts";

interface AudioProbe {
  canPlayType: (type: string) => string;
}

/** Whether this browser can decode OGG Vorbis, by `canPlayType('audio/ogg; codecs=vorbis')`. Safari answers no. */
export function supportsOgg(probe?: AudioProbe): boolean {
  try {
    const audio =
      probe ??
      (typeof Audio === "function"
        ? new Audio()
        : document.createElement("audio"));
    return audio.canPlayType('audio/ogg; codecs="vorbis"') !== "";
  } catch {
    return true;
  }
}

export function joinUrl(base: string, file: string): string {
  if (base === "") {
    return file;
  }
  return base.endsWith("/") ? `${base}${file}` : `${base}/${file}`;
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function isAbsolute(base: string): boolean {
  return base.startsWith("/") || URL_SCHEME.test(base);
}

function checkSfx(id: string, value: unknown): ManifestSfx {
  const o = value as Partial<ManifestSfx> | null;
  if (!o || typeof o.file !== "string") {
    throw new Error(`manifest sfx "${id}" has no file`);
  }
  return o as ManifestSfx;
}

function checkSong(id: string, value: unknown): ManifestSong {
  const o = value as Partial<ManifestSong> | null;
  if (!o || typeof o.file !== "string") {
    throw new Error(`manifest song "${id}" has no file`);
  }
  return o as ManifestSong;
}

/** Check the shape of a parsed manifest and resolve a relative `base` against the manifest's own URL. */
export function parseManifest(
  json: unknown,
  manifestUrl: string
): AudioManifest {
  const o = json as Partial<AudioManifest> | null;
  if (!o || typeof o !== "object") {
    throw new Error("the manifest is not a JSON object");
  }
  const sfx: Record<string, ManifestSfx> = {};
  for (const [id, value] of Object.entries(o.sfx ?? {})) {
    sfx[id] = checkSfx(id, value);
  }
  const songs: Record<string, ManifestSong> = {};
  for (const [id, value] of Object.entries(o.songs ?? {})) {
    songs[id] = checkSong(id, value);
  }
  let base = typeof o.base === "string" ? o.base : "/";
  if (!isAbsolute(base)) {
    base = new URL(
      base === "" ? "." : base,
      new URL(manifestUrl, globalThis.location?.href)
    ).href;
  }
  return {
    base,
    sampleRate: typeof o.sampleRate === "number" ? o.sampleRate : 48_000,
    sfx,
    songs,
  };
}

/** Files the manifest lists that this browser could not decode (only `.ogg` is checked). */
export function undecodableFiles(
  manifest: AudioManifest,
  oggSupported: boolean
): string[] {
  if (oggSupported) {
    return [];
  }
  const entries = [
    ...Object.entries(manifest.sfx),
    ...Object.entries(manifest.songs),
  ];
  return entries
    .filter(([, e]) => e.file.toLowerCase().endsWith(".ogg") && !e.data)
    .map(([, e]) => e.file);
}

export const OGG_ADVICE =
  "this browser cannot decode OGG Vorbis (Safari). Export with mp3 formats, or export with embed: true and play in synth mode";

/** Fetch a manifest.json (written by `bleepkit export`). Warns when it lists OGG files this browser cannot decode. */
export async function loadManifest(url: string): Promise<AudioManifest> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `could not load the manifest ${url}: ${response.status} ${response.statusText}`
    );
  }
  const manifest = parseManifest(await response.json(), url);
  const bad = undecodableFiles(manifest, supportsOgg());
  if (bad.length > 0) {
    console.warn(`bleepkit: ${OGG_ADVICE} (${bad.length} files)`);
  }
  return manifest;
}
