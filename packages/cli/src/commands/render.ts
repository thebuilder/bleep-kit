import { analysisText } from "../analysis-text.ts";
import type { Parsed } from "../args.ts";
import { CliError, type Ctx, display, fmtDb, fmtSeconds } from "../output.ts";
import {
  type DocKind,
  listIdsValid,
  openProject,
  type ProjectCtx,
  resolveRef,
} from "../project.ts";
import {
  type AudioFormat,
  type RenderEntry,
  type RenderOpts,
  renderDoc,
} from "../render.ts";
import type { CommandSpec } from "./types.ts";

interface FailedEntry {
  error: { code: string; hint?: string; issues?: unknown; message: string };
  ok: false;
  ref: string;
}

type Entry = FailedEntry | RenderEntry;

function resolveRenderRefs(
  pc: ProjectCtx,
  refs: string[]
): { id: string; kind: "sfx" | "song"; ref: string }[] {
  if (refs.length === 0) {
    return (["sfx", "song"] as const).flatMap((kind: "sfx" | "song") =>
      listIdsValid(pc.root, kind).map((id) => ({
        id,
        kind,
        ref: `${kind}/${id}`,
      }))
    );
  }
  return refs.map((r) => {
    const x = resolveRef(pc, r, ["sfx", "song", "instrument"]);
    if (x.kind === "instrument") {
      throw new CliError("usage", `${x.ref} cannot be rendered on its own`, {
        hint: "Instruments are heard through songs and sfx: render a song that uses it, e.g. bleepkit render song/title.",
      });
    }
    return { id: x.id, kind: x.kind as "sfx" | "song", ref: x.ref };
  });
}

async function renderMany(
  pc: ProjectCtx,
  targets: { id: string; kind: DocKind; ref: string }[],
  opts: RenderOpts,
  log?: (text: string) => void
): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const t of targets) {
    try {
      entries.push(
        // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose, renders are CPU bound and the log reads in document order
        await renderDoc(
          pc,
          t.kind as "sfx" | "song",
          t.id,
          opts,
          log ? { log } : {}
        )
      );
    } catch (error) {
      if (error instanceof CliError && error.code === "invalid") {
        entries.push({
          error: {
            code: error.code,
            ...(error.hint ? { hint: error.hint } : {}),
            ...(error.details?.issues ? { issues: error.details.issues } : {}),
            message: error.message,
          },
          ok: false,
          ref: t.ref,
        });
      } else {
        throw error;
      }
    }
  }
  return entries;
}

function entryLine(cwd: string, e: RenderEntry): string {
  const loop =
    e.loopStart !== null && e.loopEnd !== null
      ? `  loop ${fmtSeconds(e.loopStart)}..${fmtSeconds(e.loopEnd)}`
      : "";
  return `${e.ref.padEnd(18)} ${fmtSeconds(e.duration).padStart(7)}  peak ${fmtDb(e.peakDb).padStart(9)}  rms ${fmtDb(e.rmsDb).padStart(9)}${loop}  ${display(cwd, e.file)}${e.cached ? " (up to date)" : ""}${e.clipped ? "  CLIPPED" : ""}`;
}

/** The render options from the flags: the number flags are only set when given, so the project's values win. */
function renderOptions(args: Parsed): RenderOpts {
  const opts: RenderOpts = {
    analyze: args.bool("analyze") ?? false,
    force: args.bool("force") ?? false,
    format: (args.str("format") ?? "wav") as AudioFormat,
    images: args.bool("images") ?? false,
    stems: args.bool("stems") ?? false,
  };
  const loops = args.num("loops");
  const tail = args.num("tail");
  const rate = args.num("rate");
  if (loops !== undefined) {
    opts.loops = loops;
  }
  if (tail !== undefined) {
    opts.tail = tail;
  }
  if (rate !== undefined) {
    opts.rate = rate;
  }
  return opts;
}

/** The human lines for one entry: the render line with its stems and analysis or images, or the failure. */
function entryLines(ctx: Ctx, pc: ProjectCtx, e: Entry): string[] {
  if (!e.ok) {
    const lines = [`${e.ref}  FAILED: ${e.error.message}`];
    if (e.error.hint) {
      lines.push(`  fix: ${e.error.hint}`);
    }
    return lines;
  }
  const lines = [entryLine(ctx.cwd, e)];
  if (e.stems) {
    lines.push(
      `  stems: ${e.stems.map((s) => display(ctx.cwd, `${pc.root}/${s}`)).join(", ")}`
    );
  }
  if (e.analysis) {
    lines.push(analysisText(e.analysis, `  analysis of ${e.ref}`));
  } else if (e.images) {
    lines.push(`  images: ${Object.values(e.images).join(", ")}`);
  }
  return lines;
}

export const renderCommand: CommandSpec = {
  description:
    "Renders documents to out/<kind>/<id>.wav (16-bit master, with loop points for looping songs) plus <id>.meta.json " +
    "(hash sidecar) and, for songs, <id>.events.json. A render whose inputs did not change (document, referenced " +
    "instruments, project settings, options) is skipped and reported as up to date; --force renders anyway. With no " +
    "refs every sfx and song is rendered. --format also writes an .ogg or .mp3 next to the wav. --stems writes one mono " +
    "wav per channel, --analyze adds the analysis object, --images writes waveform/spectrogram/scopes PNGs to " +
    "out/analysis/. Exit 1 when a document is invalid, or with --strict when anything clips.",
  examples: [
    "bleepkit render sfx/coin --analyze",
    "bleepkit render --format ogg",
    "bleepkit render song/title --loops 2 --stems --images --json",
  ],
  flags: [
    {
      default: "wav",
      description: "also write this format next to the wav master",
      name: "format",
      type: "string",
      valueName: "<fmt>",
      values: ["wav", "ogg", "mp3"],
    },
    {
      default: "1",
      description: "songs: times to play the loop section",
      name: "loops",
      type: "number",
      valueName: "<n>",
    },
    {
      default: "1 (0.25 for sfx)",
      description: "seconds of release tail after the end",
      name: "tail",
      type: "number",
      valueName: "<s>",
    },
    {
      description:
        "songs: write a mono wav per channel (out/songs/<id>.stem-<channel>.wav)",
      name: "stems",
      type: "boolean",
    },
    {
      description: "include the analysis object for each render",
      name: "analyze",
      type: "boolean",
    },
    {
      description:
        "write waveform, spectrogram (and scopes for songs) PNGs to out/analysis/",
      name: "images",
      type: "boolean",
    },
    {
      default: "project sampleRate",
      description: "render sample rate, 22050 to 96000",
      name: "rate",
      type: "number",
      valueName: "<hz>",
    },
    {
      description: "render even when the sidecar says the render is up to date",
      name: "force",
      type: "boolean",
    },
    {
      description: "exit 1 when any render clips (|sample| >= 0.999)",
      name: "strict",
      type: "boolean",
    },
  ],
  name: "render",
  run: async (ctx, args) => {
    const pc = openProject(ctx);
    const targets = resolveRenderRefs(pc, args.positionals);
    if (targets.length === 0) {
      throw new CliError(
        "not-found",
        "nothing to render: the project has no sfx or songs",
        {
          hint: "Create one with: bleepkit new sfx coin --category coin",
        }
      );
    }
    const opts = renderOptions(args);
    const entries = await renderMany(pc, targets, opts, (t) => ctx.progress(t));
    const failed = entries.filter((e): e is FailedEntry => !e.ok);
    const rendered = entries.filter((e): e is RenderEntry => e.ok);
    const clipped = rendered.filter((e) => e.clipped);
    const strict = args.bool("strict") ?? false;
    const ok = failed.length === 0 && !(strict && clipped.length > 0);
    const lines = entries.flatMap((e) => entryLines(ctx, pc, e));
    if (clipped.length > 0) {
      lines.push(
        `warning: ${clipped.map((c) => c.ref).join(", ")} clip${clipped.length === 1 ? "s" : ""} (peak at full scale). Lower the document's "volume" (sfx) or channel volumes (song).`
      );
    }
    return {
      exit: ok ? 0 : 1,
      human: lines.join("\n"),
      json: { ok, renders: entries, root: pc.root },
    };
  },
  summary: "render to out/ (wav, ogg, mp3), optionally with analysis",
  usage:
    "render [ref...] [--format wav] [--loops 1] [--tail 1] [--stems] [--analyze] [--images] [--rate 48000]",
};
