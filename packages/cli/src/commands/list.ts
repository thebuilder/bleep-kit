import fs from "node:fs";
import path from "node:path";
import { CliError, fmtSeconds, table } from "../output.ts";
import {
  type DocKind,
  docRel,
  ID_PATTERN,
  listIds,
  normalizeDocument,
  openProject,
  type ProjectCtx,
  readJsonFile,
} from "../project.ts";
import { freshness, readMeta } from "../render.ts";
import type { CommandSpec } from "./types.ts";

interface Row {
  id: string;
  ok: boolean;
  path: string;
  ref: string;
  [key: string]: unknown;
}

function row(pc: ProjectCtx, kind: DocKind, id: string): Row {
  const rel = docRel(kind, id);
  const base = { id, ok: true, path: rel, ref: `${kind}/${id}` };
  let raw: Record<string, unknown>;
  try {
    raw = readJsonFile(path.join(pc.root, rel), rel) as Record<string, unknown>;
  } catch (error) {
    return { ...base, error: (error as Error).message, ok: false };
  }
  const n = normalizeDocument(
    kind,
    raw,
    kind === "song" ? pc.instruments() : undefined
  );
  const v = n.value as unknown as Record<string, unknown>;
  const out: Row = {
    ...base,
    chip: v.chip ?? null,
    name: v.name ?? id,
    ok: n.ok && ID_PATTERN.test(id),
  };
  if (kind === "sfx") {
    out.category = v.category;
  }
  if (kind === "instrument") {
    out.kind = v.kind;
  }
  if (kind === "song") {
    out.tempo = v.tempo;
  }
  if (kind !== "instrument") {
    const meta = readMeta(pc, kind, id);
    const wav = path.join(
      pc.root,
      `out/${kind === "sfx" ? "sfx" : "songs"}/${id}.wav`
    );
    out.render =
      meta && fs.existsSync(wav)
        ? {
            clipped: meta.clipped,
            duration: meta.duration,
            path: `out/${kind === "sfx" ? "sfx" : "songs"}/${id}.wav`,
            peakDb: meta.peakDb,
            stale: n.ok ? freshness(pc, kind, id) !== "fresh" : true,
          }
        : null;
  }
  return out;
}

const KIND_ARGS: Record<string, DocKind> = {
  instrument: "instrument",
  instruments: "instrument",
  sfx: "sfx",
  song: "song",
  songs: "song",
};

function section(
  title: string,
  rows: Row[],
  cols: (r: Row) => string[]
): string {
  if (rows.length === 0) {
    return `${title}: none`;
  }
  return `${title} (${rows.length})\n${table(rows.map((r) => [`  ${r.id}`, ...cols(r)]))}`;
}

function renderCell(r: Row): string {
  const render = r.render as
    | { clipped: boolean; duration: number; stale: boolean }
    | null
    | undefined;
  if (render === undefined) {
    return "";
  }
  if (render === null) {
    return "not rendered";
  }
  return `${fmtSeconds(render.duration)}${render.stale ? " (stale)" : ""}${render.clipped ? " CLIPPED" : ""}`;
}

export const listCommand: CommandSpec = {
  description:
    "Lists documents with name, chip, category or kind, and the duration of the render in out/ (marked stale when the " +
    "document changed since). Without a kind it lists sfx, songs and instruments.",
  examples: ["bleepkit list", "bleepkit list sfx --json"],
  flags: [],
  name: "list",
  run: (ctx, args) => {
    const pc = openProject(ctx);
    const [arg] = args.positionals;
    let kinds: DocKind[] = ["sfx", "song", "instrument"];
    if (arg) {
      const k = KIND_ARGS[arg];
      if (!k) {
        throw new CliError("usage", `unknown kind "${arg}"`, {
          hint: "Use one of: sfx, songs, instruments.",
        });
      }
      kinds = [k];
    }
    const json: Record<string, unknown> = { ok: true, root: pc.root };
    const blocks: string[] = [
      `project: ${pc.project.name} (${pc.project.chip}) at ${pc.root}`,
    ];
    for (const kind of kinds) {
      const rows = listIds(pc.root, kind).map((id) => row(pc, kind, id));
      if (kind === "sfx") {
        json.sfx = rows;
        blocks.push(
          section("sfx", rows, (r) => [
            String(r.category ?? ""),
            String(r.chip ?? ""),
            renderCell(r),
          ])
        );
      } else if (kind === "song") {
        json.songs = rows;
        blocks.push(
          section("songs", rows, (r) => [
            `${r.tempo ?? ""} bpm`,
            String(r.chip ?? ""),
            renderCell(r),
          ])
        );
      } else {
        json.instruments = rows;
        blocks.push(
          section("instruments", rows, (r) => [
            String(r.kind ?? ""),
            String(r.chip ?? "any chip"),
          ])
        );
      }
    }
    const bad = Object.values(json)
      .filter(Array.isArray)
      .flat()
      .filter((r) => (r as Row).ok === false).length;
    if (bad > 0) {
      blocks.push(
        `${bad} document${bad === 1 ? "" : "s"} with problems: run \`bleepkit validate\``
      );
    }
    return { human: blocks.join("\n"), json };
  },
  summary: "list documents and their renders",
  usage: "list [sfx|songs|instruments]",
};
