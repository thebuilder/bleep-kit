import fs from "node:fs";
import path from "node:path";
import { fmtSeconds } from "@bleepkit/agent";
import { CliError, table } from "../output.ts";
import {
  type DocKind,
  docContext,
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

/** The columns of a sample row: format, rate and length in seconds (the audio itself stays out of the listing). */
function sampleFields(v: Record<string, unknown>): Record<string, unknown> {
  const frames =
    typeof v.data === "string"
      ? Math.floor((v.data.length * 3) / 4 / (v.bits === 8 ? 1 : 2))
      : 0;
  const rate = typeof v.rate === "number" ? v.rate : 1;
  return {
    baseNote: v.baseNote,
    bits: v.bits,
    chip: null,
    rate: v.rate,
    seconds: Math.round((frames / rate) * 100) / 100,
  };
}

/** The render in out/ of an sfx or song, or null when there is none. */
function renderInfo(
  pc: ProjectCtx,
  kind: "sfx" | "song",
  id: string,
  ok: boolean
): Record<string, unknown> | null {
  const meta = readMeta(pc, kind, id);
  const rel = `out/${kind === "sfx" ? "sfx" : "songs"}/${id}.wav`;
  if (!(meta && fs.existsSync(path.join(pc.root, rel)))) {
    return null;
  }
  return {
    clipped: meta.clipped,
    duration: meta.duration,
    path: rel,
    peakDb: meta.peakDb,
    stale: ok ? freshness(pc, kind, id) !== "fresh" : true,
  };
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
  const n = normalizeDocument(kind, raw, docContext(pc, kind));
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
  if (kind === "sample") {
    Object.assign(out, sampleFields(v));
  }
  if (kind === "song") {
    out.tempo = v.tempo;
  }
  if (kind === "sfx" || kind === "song") {
    out.render = renderInfo(pc, kind, id, n.ok);
  }
  return out;
}

const KIND_ARGS: Record<string, DocKind> = {
  instrument: "instrument",
  instruments: "instrument",
  sample: "sample",
  samples: "sample",
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
    "document changed since). Without a kind it lists sfx, songs, instruments and samples.",
  examples: ["bleepkit list", "bleepkit list sfx --json"],
  flags: [],
  name: "list",
  run: (ctx, args) => {
    const pc = openProject(ctx);
    const [arg] = args.positionals;
    let kinds: DocKind[] = ["sfx", "song", "instrument", "sample"];
    if (arg) {
      const k = KIND_ARGS[arg];
      if (!k) {
        throw new CliError("usage", `unknown kind "${arg}"`, {
          hint: "Use one of: sfx, songs, instruments, samples.",
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
      } else if (kind === "sample") {
        json.samples = rows;
        blocks.push(
          section("samples", rows, (r) => [
            `${r.bits ?? ""} bit ${r.rate ?? ""} Hz`,
            `${r.seconds ?? 0} s`,
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
  usage: "list [sfx|songs|instruments|samples]",
};
