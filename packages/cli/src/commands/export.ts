import path from "node:path";
import { type Issue, songToMod } from "@bleepkit/core";
import type { Parsed } from "../args.ts";
import { runExport } from "../exporter.ts";
import { CliError, type CommandResult, type Ctx, display } from "../output.ts";
import {
  instrumentsFor,
  loadDoc,
  openProject,
  parseRef,
  requireOk,
  samplesFor,
  toPosix,
  writeFileAtomic,
} from "../project.ts";
import type { AudioFormat } from "../render.ts";
import type { CommandSpec } from "./types.ts";

const FORMATS = ["wav", "ogg", "mp3"] as const;

/** `export mod song/<id>`: an amiga song as a 4 channel ProTracker module, next to its other renders. */
function exportMod(
  ctx: Ctx,
  args: Parsed,
  refText: string | undefined
): CommandResult {
  if (!refText) {
    throw new CliError(
      "usage",
      "export mod needs a song: export mod <song> [--out <file.mod>]",
      {
        hint: "Example: bleepkit export mod song/chiptune --out chiptune.mod",
      }
    );
  }
  const pc = openProject(ctx);
  const parsed = parseRef(refText);
  if (parsed.kind !== null && parsed.kind !== "song") {
    throw new CliError(
      "usage",
      `export mod takes a song, not ${parsed.kind}/${parsed.id}`
    );
  }
  const doc = loadDoc(pc, "song", parsed.id);
  requireOk(doc);
  const instruments = instrumentsFor(pc, doc.value);
  const result = songToMod(doc.value, instruments, samplesFor(pc, instruments));
  const show = (list: Issue[]) =>
    list.map(
      (i) => `  ${i.severity} ${i.path ? `${i.path}: ` : ""}${i.message}`
    );
  if (result.bytes === null) {
    throw new CliError(
      "invalid",
      `cannot export ${doc.ref} as a MOD:\n${show(result.issues).join("\n")}`,
      {
        details: { issues: result.issues },
        hint: "Only amiga songs whose instruments are samples export to MOD.",
      }
    );
  }
  const out = args.str("out");
  const abs = out
    ? path.resolve(ctx.cwd, out)
    : path.join(pc.root, "out", "songs", `${parsed.id}.mod`);
  writeFileAtomic(abs, result.bytes);
  const shown = display(ctx.cwd, abs);
  return {
    human: [
      `Wrote ${shown} (${result.bytes.length} bytes) from ${doc.ref}`,
      ...show(result.issues),
    ].join("\n"),
    json: {
      bytes: result.bytes.length,
      issues: result.issues,
      ok: true,
      path: out ? shown : toPosix(path.relative(pc.root, abs)),
      ref: doc.ref,
    },
  };
}

export const exportCommand: CommandSpec = {
  description:
    "Renders every sfx and song whose render is stale, encodes them to the project's export formats and writes them to " +
    "export.dir, then writes the typed manifest (export.manifest, an audio.ts with SfxId/SongId types) and " +
    "manifest.json next to the audio. Files that are already current are left alone, so repeated exports are cheap and " +
    "the manifest only changes when something did. Nothing is written when any document has errors. OGG loops " +
    "gaplessly; MP3 adds encoder delay, so the manifest's loop points are shifted by 1105 frames and a warning says " +
    "they are approximate. --clean removes audio files in the folder that no document produces; --dry-run shows " +
    "everything that would change without touching disk. Path flags are relative to the cwd. `export mod <song>` is " +
    "different: it writes one amiga song as a 4 channel ProTracker .mod (out/songs/<id>.mod, or --out), with samples " +
    "resampled to ProTracker's pitch table; what a MOD cannot hold (more than one effect per cell, pan, duty, more " +
    "than 31 samples, 128 patterns) is listed as warnings.",
  examples: [
    "bleepkit export --dry-run",
    "bleepkit export --clean",
    "bleepkit export --music-format mp3 --embed --json",
    "bleepkit export mod song/chiptune --out chiptune.mod",
  ],
  flags: [
    {
      description:
        "export mod: where to write the .mod (default out/songs/<id>.mod)",
      name: "out",
      type: "string",
      valueName: "<file>",
    },
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
    if (args.positionals[0] === "mod") {
      return exportMod(ctx, args, args.positionals[1]);
    }
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
    "export [--dir] [--manifest] [--sfx-format] [--music-format] [--embed] [--clean] [--dry-run] | export mod <song> [--out]",
};
