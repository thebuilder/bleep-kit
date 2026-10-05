// The typed audio manifest (architecture.md section 7): audio.ts for games, manifest.json for loadManifest.
// Pure functions, no file system, so the output is easy to test.

import type { AudioManifest, ManifestSfx, ManifestSong } from "@bleepkit/core";
import { MP3_ENCODER_DELAY_FRAMES } from "./render.ts";

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export const MP3_LOOP_WARNING =
  "MP3 loop points are approximate; use OGG for seamless loops";

function key(k: string): string {
  return IDENT.test(k) ? k : JSON.stringify(k);
}

/** Text that is already TypeScript and goes into a literal as it is. */
class Raw {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }
}

/** A TypeScript object literal: unquoted identifier keys, two space indent, JSON values. */
export function tsLiteral(value: unknown, depth = 0): string {
  const pad = "  ".repeat(depth);
  const inner = "  ".repeat(depth + 1);
  if (value instanceof Raw) {
    return value.text;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    if (value.every((v) => v === null || typeof v !== "object")) {
      return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
    }
    return `[\n${value.map((v) => inner + tsLiteral(v, depth + 1)).join(",\n")},\n${pad}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined
    );
    if (entries.length === 0) {
      return "{}";
    }
    return `{\n${entries.map(([k, v]) => `${inner}${key(k)}: ${tsLiteral(v, depth + 1)}`).join(",\n")},\n${pad}}`;
  }
  // JSON.stringify returns undefined for undefined, functions and symbols
  // biome-ignore lint/suspicious/noUnnecessaryConditions: the type lies
  return JSON.stringify(value) ?? "null";
}

/** Seconds, enough digits that a loop point lands on the same sample after decoding (1 microsecond). */
export function seconds(value: number): number {
  return Number(value.toFixed(6));
}

/** MP3 decoders add encoder delay at the start, so loop points shift by it (the manifest compensates). */
export function mp3Shift(sampleRate: number): number {
  return MP3_ENCODER_DELAY_FRAMES / sampleRate;
}

function sorted<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1))
  );
}

/**
 * The manifest as the generated `as const` literal. Embedded documents (`data`) are cast to their type: `as const`
 * would make every array in them readonly, and the readonly arrays do not satisfy `AudioManifest`.
 */
function manifestLiteral(manifest: AudioManifest): string {
  const embedded = <T extends ManifestSfx | ManifestSong>(
    entry: T,
    type: string
  ): T | Record<string, unknown> => {
    if (entry.data === undefined) {
      return entry;
    }
    // the entry sits at depth 2 of the manifest, so its data at depth 3
    return {
      ...entry,
      data: new Raw(`${tsLiteral(entry.data, 3)} as ${type}`),
    };
  };
  return tsLiteral({
    ...manifest,
    sfx: Object.fromEntries(
      Object.entries(manifest.sfx).map(([id, s]) => [
        id,
        embedded(s, 'NonNullable<ManifestSfx["data"]>'),
      ])
    ),
    songs: Object.fromEntries(
      Object.entries(manifest.songs).map(([id, s]) => [
        id,
        embedded(s, 'NonNullable<ManifestSong["data"]>'),
      ])
    ),
  });
}

/** One entry per line: `id: "file"` for sfx, `id: { duration: 1, file: "x.ogg", ... }` for songs. */
function entriesLiteral(o: Record<string, unknown>): string {
  const entries = Object.entries(o);
  if (entries.length === 0) {
    return "{}";
  }
  const lines = entries.map(([id, v]) => {
    const text =
      typeof v === "string"
        ? JSON.stringify(v)
        : `{ ${Object.entries(v as Record<string, unknown>)
            .map(([k, x]) => `${key(k)}: ${JSON.stringify(x)}`)
            .join(", ")} }`;
    return `  ${key(id)}: ${text},`;
  });
  return `{\n${lines.join("\n")}\n}`;
}

/**
 * The generated audio.ts (section 7). The manifest is `as const satisfies AudioManifest`: the literal keys survive,
 * so `createPlayer({ manifest })` types `player.sfx(id)` and `player.music(id)` by them, and the shape is still
 * checked against the player's `AudioManifest`.
 */
export function manifestTs(manifest: AudioManifest): string {
  const sfxFiles = Object.fromEntries(
    Object.entries(manifest.sfx).map(([id, s]) => [id, s.file])
  );
  const songSummary = Object.fromEntries(
    Object.entries(manifest.songs).map(([id, s]) => [
      id,
      {
        duration: s.duration,
        file: s.file,
        loopEnd: s.loopEnd,
        loopStart: s.loopStart,
      },
    ])
  );
  const embeds = [
    ...Object.values(manifest.sfx),
    ...Object.values(manifest.songs),
  ].some((entry) => entry.data !== undefined);
  const types = embeds
    ? "AudioManifest, ManifestSfx, ManifestSong"
    : "AudioManifest";
  return [
    "/* Generated by bleepkit export. Do not edit. */",
    `import type { ${types} } from "@bleepkit/player";`,
    "",
    `export const sfx = ${entriesLiteral(sfxFiles)} as const;`,
    "",
    `export const songs = ${entriesLiteral(songSummary)} as const;`,
    "",
    "export type SfxId = keyof typeof sfx;",
    "export type SongId = keyof typeof songs;",
    "",
    `export const manifest = ${manifestLiteral(manifest)} as const satisfies AudioManifest;`,
    "",
  ].join("\n");
}

export function manifestJson(manifest: AudioManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export { sorted as sortedRecord };
