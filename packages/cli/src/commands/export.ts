import path from "node:path";
import { runExport } from "../exporter.ts";
import { display } from "../output.ts";
import { openProject } from "../project.ts";
import type { AudioFormat } from "../render.ts";
import type { CommandSpec } from "./types.ts";

const FORMATS = ["wav", "ogg", "mp3"] as const;

export const exportCommand: CommandSpec = {
  description:
    "Renders every sfx and song whose render is stale, encodes them to the project's export formats and writes them to " +
    "export.dir, then writes the typed manifest (export.manifest, an audio.ts with SfxId/SongId types) and " +
    "manifest.json next to the audio. Files that are already current are left alone, so repeated exports are cheap and " +
    "the manifest only changes when something did. Nothing is written when any document has errors. OGG loops " +
    "gaplessly; MP3 adds encoder delay, so the manifest's loop points are shifted by 1105 frames and a warning says " +
    "they are approximate. --clean removes audio files in the folder that no document produces; --dry-run shows " +
    "everything that would change without touching disk. Path flags are relative to the cwd.",
  examples: [
    "bleepkit export --dry-run",
    "bleepkit export --clean",
    "bleepkit export --music-format mp3 --embed --json",
  ],
  flags: [
    {
      default: "project export.dir",
      description: "folder the game loads audio from",
      name: "dir",
      type: "string",
      valueName: "<dir>",
    },
    {
      default: "project export.manifest",
      description: "path of the generated audio.ts",
      name: "manifest",
      type: "string",
      valueName: "<file>",
    },
    {
      description: "format of sfx files (wav, ogg, mp3)",
      name: "sfx-format",
      type: "string",
      valueName: "<fmt>",
      values: FORMATS,
    },
    {
      description: "format of song files (wav, ogg, mp3)",
      name: "music-format",
      type: "string",
      valueName: "<fmt>",
      values: FORMATS,
    },
    {
      description:
        "embed the JSON documents in the manifest so the player can synthesize without files",
      name: "embed",
      type: "boolean",
    },
    {
      description:
        "remove audio files in the export folder that no document produces",
      name: "clean",
      type: "boolean",
    },
    {
      description: "list what would change; write nothing",
      name: "dry-run",
      type: "boolean",
    },
  ],
  name: "export",
  run: async (ctx, args) => {
    const pc = openProject(ctx);
    const dir = args.str("dir");
    const manifest = args.str("manifest");
    const sfx = args.str("sfx-format");
    const music = args.str("music-format");
    const result = await runExport(
      pc,
      {
        clean: args.bool("clean") ?? false,
        ...(dir ? { dir: path.resolve(ctx.cwd, dir) } : {}),
        dryRun: args.bool("dry-run") ?? false,
        ...(args.bool("embed") === undefined
          ? {}
          : { embed: args.bool("embed") as boolean }),
        ...(manifest ? { manifest: path.resolve(ctx.cwd, manifest) } : {}),
        ...(music ? { musicFormat: music as AudioFormat } : {}),
        ...(sfx ? { sfxFormat: sfx as AudioFormat } : {}),
      },
      (t) => ctx.progress(t)
    );
    const show = (rels: string[]) =>
      rels.map((r) => `  ${display(ctx.cwd, path.resolve(pc.root, r))}`);
    const verb = result.dryRun ? "would write" : "wrote";
    const lines: string[] = [];
    if (result.rendered.length > 0) {
      lines.push(
        `${result.dryRun ? "would render" : "rendered"} ${result.rendered.length}: ${result.rendered.join(", ")}`
      );
    }
    lines.push(
      result.written.length > 0
        ? `${verb} ${result.written.length} file${result.written.length === 1 ? "" : "s"}:`
        : "nothing to write: everything is up to date",
      ...show(result.written)
    );
    if (result.removed.length > 0) {
      lines.push(
        `${result.dryRun ? "would remove" : "removed"} ${result.removed.length}:`,
        ...show(result.removed)
      );
    }
    if (result.upToDate.length > 0) {
      lines.push(`${result.upToDate.length} already current`);
    }
    for (const w of result.warnings) {
      lines.push(`warning: ${w}`);
    }
    lines.push(
      `manifest: ${display(ctx.cwd, path.resolve(pc.root, result.manifest))}`
    );
    return { human: lines.join("\n"), json: { ...result } };
  },
  summary: "encode everything and write the game's audio folder and audio.ts",
  usage:
    "export [--dir] [--manifest] [--sfx-format] [--music-format] [--embed] [--clean] [--dry-run]",
};
