// biome-ignore-all assist/source/useSortedKeys: the key order of a document is part of its file format (version first, then name and the rest as written in the architecture)
import type { Normalized, Project, ProjectExport } from "../types.ts";
import { CHIP_IDS, FORMAT_VERSION } from "../types.ts";
import { defaultProject } from "./defaults.ts";
import {
  boolField,
  dropUnknown,
  enumField,
  error,
  finish,
  isRec,
  newCtx,
  numField,
  readId,
  readVersion,
  section,
  show,
  strField,
} from "./issues.ts";
import { migrate } from "./migrate.ts";

const PROJECT_KEYS = [
  "id",
  "version",
  "name",
  "chip",
  "sampleRate",
  "seed",
  "master",
  "export",
];
const MASTER_KEYS = ["volume", "limiter"];
const EXPORT_KEYS = [
  "dir",
  "manifest",
  "baseUrl",
  "sfxFormat",
  "musicFormat",
  "oggQuality",
  "mp3Bitrate",
  "events",
  "embed",
];
const FORMATS = ["wav", "ogg", "mp3"] as const;

export function normalizeProject(input: unknown): Normalized<Project> {
  const ctx = newCtx();
  if (!isRec(input)) {
    error(ctx, "", `must be an object (was ${show(input)})`);
    return finish(ctx, defaultProject());
  }
  const def = defaultProject();
  const from = readVersion(ctx, input, FORMAT_VERSION);
  const doc = migrate(input, from);
  dropUnknown(ctx, doc, "", PROJECT_KEYS);
  const id = readId(ctx, doc);

  const master = section(ctx, doc, "master", "");
  dropUnknown(ctx, master, "/master", MASTER_KEYS);
  const ex = section(ctx, doc, "export", "");
  dropUnknown(ctx, ex, "/export", EXPORT_KEYS);

  const exp: ProjectExport = {
    dir: strField(ctx, ex, "dir", "/export", def.export.dir),
    manifest: strField(ctx, ex, "manifest", "/export", def.export.manifest),
    baseUrl: strField(ctx, ex, "baseUrl", "/export", def.export.baseUrl),
    sfxFormat: enumField(
      ctx,
      ex,
      "sfxFormat",
      "/export",
      FORMATS,
      def.export.sfxFormat
    ),
    musicFormat: enumField(
      ctx,
      ex,
      "musicFormat",
      "/export",
      FORMATS,
      def.export.musicFormat
    ),
    oggQuality: numField(ctx, ex, "oggQuality", "/export", {
      min: -1,
      max: 10,
      def: def.export.oggQuality,
    }),
    mp3Bitrate: numField(ctx, ex, "mp3Bitrate", "/export", {
      min: 64,
      max: 320,
      int: true,
      def: def.export.mp3Bitrate,
    }),
    events: boolField(ctx, ex, "events", "/export", def.export.events),
    embed: boolField(ctx, ex, "embed", "/export", def.export.embed),
  };

  const value: Project = {
    version: FORMAT_VERSION,
    name: strField(ctx, doc, "name", "", def.name),
    chip: enumField(ctx, doc, "chip", "", CHIP_IDS, def.chip),
    sampleRate: enumField(
      ctx,
      doc,
      "sampleRate",
      "",
      [44_100, 48_000] as const,
      def.sampleRate
    ),
    seed: numField(ctx, doc, "seed", "", {
      min: 0,
      max: 4_294_967_295,
      int: true,
      def: def.seed,
    }),
    master: {
      volume: numField(ctx, master, "volume", "/master", {
        min: 0,
        max: 1,
        def: def.master.volume,
      }),
      limiter: boolField(ctx, master, "limiter", "/master", def.master.limiter),
    },
    export: exp,
  };
  if (id !== undefined) {
    (value as Project & { id?: string }).id = id;
  }
  return finish(ctx, value);
}
