import fs from "node:fs";
import path from "node:path";
import {
  defaultKindFor,
  describeInstrument,
  describeSong,
  kindsForChip,
  makeSong,
  PRESETS,
  type Preset,
  planSong,
  type Template,
} from "@bleepkit/agent";
import {
  CHANNEL_KINDS,
  CHIP_IDS,
  type ChannelKind,
  type ChipId,
  deriveSeed,
  makeInstrument,
  mmlToPatterns,
  normalizeInstrument,
  normalizeSfx,
  normalizeSong,
  parseMml,
  SFX_CATEGORIES,
  type SfxCategory,
} from "@bleepkit/core";
import { describeSfx, generateSfx } from "@bleepkit/sfx";
import { CliError } from "../output.ts";
import {
  checkId,
  type DocKind,
  docRel,
  openProject,
  type ProjectCtx,
  requireOk,
  writeDoc,
} from "../project.ts";
import type { CommandSpec } from "./types.ts";

function guardExists(
  pc: ProjectCtx,
  kind: DocKind,
  id: string,
  force: boolean
): void {
  if (!force && fs.existsSync(path.join(pc.root, docRel(kind, id)))) {
    throw new CliError(
      "invalid",
      `${kind}/${id} already exists (${docRel(kind, id)})`,
      {
        hint: "Pick another id, or pass --force to overwrite it.",
      }
    );
  }
}

function chipOf(pc: ProjectCtx, value: string | undefined): ChipId {
  return (value ?? pc.project.chip) as ChipId;
}

const chipFlag = {
  description: `chip (default: the project's chip): ${CHIP_IDS.join(", ")}`,
  name: "chip",
  type: "string",
  valueName: "<chip>",
  values: CHIP_IDS,
} as const;

const forceFlag = {
  description: "overwrite an existing document with the same id",
  name: "force",
  type: "boolean",
} as const;

function newSfx(
  ctx: Parameters<CommandSpec["run"]>[0],
  args: Parameters<CommandSpec["run"]>[1],
  id: string
) {
  const category = args.str("category");
  if (!category) {
    throw new CliError("usage", "new sfx needs --category", {
      hint: `Pick one of: ${SFX_CATEGORIES.join(", ")}. Example: bleepkit new sfx ${id} --category coin`,
    });
  }
  const pc = openProject(ctx);
  guardExists(pc, "sfx", id, args.bool("force") ?? false);
  const chip = chipOf(pc, args.str("chip"));
  const seed =
    args.num("seed") ?? ctx.seed ?? deriveSeed(pc.seed, `${category}:${id}`);
  const raw = generateSfx(category as SfxCategory, {
    chip,
    name: args.str("name") ?? id,
    seed,
  });
  const n = normalizeSfx(raw);
  requireOk({ ...n, ref: `sfx/${id}`, rel: docRel("sfx", id) });
  const rel = writeDoc(pc, "sfx", id, n.value);
  const description = describeSfx(n.value);
  return {
    human: `Created sfx/${id} (${rel}), seed ${seed}\n${description}\nNext: bleepkit render sfx/${id} --analyze`,
    json: { description, doc: n.value, ok: true, path: rel, root: pc.root },
  };
}

function newInstrument(
  ctx: Parameters<CommandSpec["run"]>[0],
  args: Parameters<CommandSpec["run"]>[1],
  id: string
) {
  const pc = openProject(ctx);
  guardExists(pc, "instrument", id, args.bool("force") ?? false);
  const chip = chipOf(pc, args.str("chip"));
  const preset = (args.str("preset") ?? "lead") as Preset;
  const kind = (args.str("kind") ??
    defaultKindFor(chip, preset)) as ChannelKind;
  const allowed = kindsForChip(chip);
  if (!allowed.includes(kind)) {
    throw new CliError(
      "usage",
      `chip ${chip} has no ${kind} channels (it has: ${allowed.join(", ")})`,
      {
        hint: `Use --kind ${allowed[0]} or another chip: bleepkit new instrument ${id} --kind ${kind} --chip custom`,
      }
    );
  }
  const raw = makeInstrument(kind, chip, preset, args.str("name") ?? id);
  const userSample = args.str("sample");
  if (userSample !== undefined) {
    if (kind !== "sample" || !raw.sample) {
      throw new CliError(
        "usage",
        "--sample only applies to sample instruments",
        {
          hint: "Add --kind sample (chips with sample channels: amiga, snes, custom).",
        }
      );
    }
    raw.sample = { ...raw.sample, userSample };
  }
  const n = normalizeInstrument(raw, pc.samples());
  requireOk({ ...n, ref: `instrument/${id}`, rel: docRel("instrument", id) });
  const rel = writeDoc(pc, "instrument", id, n.value);
  return {
    human: `Created instrument/${id} (${rel})\n${describeInstrument(n.value)}\nUse it in MML with @${id}, or set a channel's "instrument": "${id}".`,
    json: { doc: n.value, ok: true, path: rel, root: pc.root },
  };
}

function parseMmlFlags(
  values: string[],
  channelIds: string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values) {
    const eq = v.indexOf("=");
    if (eq <= 0) {
      throw new CliError("usage", `--mml needs <channel>=<mml> (got "${v}")`, {
        hint: `Example: --mml pulse1="o4 l8 cdefgab>c"   (channels: ${channelIds.join(", ")})`,
      });
    }
    const channel = v.slice(0, eq).trim();
    if (!channelIds.includes(channel)) {
      throw new CliError(
        "usage",
        `unknown channel "${channel}" for this chip`,
        {
          hint: `Channels: ${channelIds.join(", ")}`,
        }
      );
    }
    out[channel] = v.slice(eq + 1);
  }
  return out;
}

function newSong(
  ctx: Parameters<CommandSpec["run"]>[0],
  args: Parameters<CommandSpec["run"]>[1],
  id: string
) {
  const pc = openProject(ctx);
  guardExists(pc, "song", id, args.bool("force") ?? false);
  const chip = chipOf(pc, args.str("chip"));
  const template = (args.str("template") ?? "empty") as Template;
  const tempo = args.num("tempo") ?? 120;
  const channelIds = makeSong({
    chip,
    instruments: {},
    mml: {},
    name: id,
    template: "empty",
    tempo,
  }).channels.map((c) => c.id);
  const mml = parseMmlFlags(args.list("mml"), channelIds);
  for (const [channel, text] of Object.entries(mml)) {
    const parsed = parseMml(text);
    const errors = parsed.issues.filter((i) => i.severity === "error");
    if (errors.length > 0) {
      throw new CliError(
        "invalid",
        `MML for ${channel} has errors:\n${errors.map((e) => `  ${e.message}`).join("\n")}`,
        {
          hint: "See `bleepkit help formats mml`. Notes are c d e f g a b, r is a rest, o4 sets the octave, l8 the default length.",
        }
      );
    }
  }
  // channels that play notes get an instrument that fits the chip: one the project has, else one made from the presets
  const plan = planSong({
    chip,
    create: true,
    instruments: pc.instruments(),
    mml,
    name: args.str("name") ?? id,
    template,
    tempo,
  });
  const n = normalizeSong(plan.song, { ...pc.instruments(), ...plan.created });
  requireOk({ ...n, ref: `song/${id}`, rel: docRel("song", id) });
  const madeRels = Object.entries(plan.created).map(([made, raw]) => {
    const inst = normalizeInstrument(raw);
    requireOk({
      ...inst,
      ref: `instrument/${made}`,
      rel: docRel("instrument", made),
    });
    return writeDoc(pc, "instrument", made, inst.value);
  });
  // MML is the way to type a tune in; the song is stored as tracker patterns
  const converted = mmlToPatterns(n.value);
  const { song } = converted;
  const rel = writeDoc(pc, "song", id, song);
  const warnings = [...n.issues, ...converted.issues].filter(
    (i) => i.severity === "warning"
  );
  return {
    human: [
      `Created song/${id} (${rel})`,
      ...madeRels.map(
        (r) =>
          `Created ${r} from the ${chip} presets for a channel no instrument of the project fits`
      ),
      describeSong(song),
      ...warnings.map((w) => `warning ${w.path}: ${w.message}`),
      `Next: bleepkit render song/${id} --analyze`,
    ].join("\n"),
    json: {
      doc: song,
      instruments: madeRels,
      ok: true,
      path: rel,
      root: pc.root,
      warnings,
    },
  };
}

export const newCommand: CommandSpec = {
  description:
    "Creates a document. `new sfx` generates one deterministically from --category and a seed derived from the project " +
    "seed and the id (same inputs, same sound); `new instrument` writes a preset instrument; `new song` writes a song " +
    "with channels for the chip, each pointed at a matching project instrument, optionally with MML per channel (MML is typed in, the song is saved as tracker patterns). " +
    "Exits 1 when the id exists (use --force). The new document is validated before it is written.",
  examples: [
    "bleepkit new sfx jump --category jump --chip nes",
    "bleepkit new instrument pluck --kind pulse --preset lead",
    'bleepkit new song title --tempo 140 --mml pulse1="o4 l8 cdefgab>c" --mml triangle="o2 l4 c g c g"',
  ],
  flags: [
    {
      description: `sfx: category (required): ${SFX_CATEGORIES.join(", ")}`,
      name: "category",
      type: "string",
      valueName: "<category>",
      values: SFX_CATEGORIES,
    },
    chipFlag,
    {
      description: "label stored in the document (default: the id)",
      name: "name",
      type: "string",
      valueName: "<name>",
    },
    {
      description: `instrument: channel kind (default depends on the chip and preset: a bass uses the chip's bass voice, bass-pulse a pulse): ${CHANNEL_KINDS.join(", ")}`,
      name: "kind",
      type: "string",
      valueName: "<kind>",
      values: CHANNEL_KINDS,
    },
    {
      description:
        "instrument: play the user sample samples/<id>.json (needs --kind sample; see `bleepkit import sample`)",
      name: "sample",
      type: "string",
      valueName: "<id>",
    },
    {
      default: "lead",
      description: `instrument: starting point: ${PRESETS.join(", ")}`,
      name: "preset",
      type: "string",
      valueName: "<preset>",
      values: PRESETS,
    },
    {
      default: "120",
      description: "song: beats per minute",
      name: "tempo",
      type: "number",
      valueName: "<bpm>",
    },
    {
      description:
        "song: MML for one channel as <channel>=<mml>; repeat for several channels",
      name: "mml",
      type: "list",
      valueName: "<ch>=<mml>",
    },
    {
      default: "empty",
      description:
        "song: empty (one 64 row pattern, or no patterns when any --mml is given) or loop8 (8 empty bars, loop at order 0)",
      name: "template",
      type: "string",
      valueName: "<template>",
      values: ["empty", "loop8"],
    },
    forceFlag,
  ],
  name: "new",
  run: (ctx, args) => {
    const [kind, id, ...rest] = args.positionals;
    if (!(kind && id) || rest.length > 0) {
      throw new CliError(
        "usage",
        "new needs a kind and an id: new sfx|instrument|song <id>",
        {
          hint: "Example: bleepkit new sfx coin --category coin",
        }
      );
    }
    checkId(id);
    if (kind === "sfx") {
      return newSfx(ctx, args, id);
    }
    if (kind === "instrument") {
      return newInstrument(ctx, args, id);
    }
    if (kind === "song") {
      return newSong(ctx, args, id);
    }
    throw new CliError("usage", `unknown document kind "${kind}" for new`, {
      hint: "Use new sfx, new instrument or new song.",
    });
  },
  summary: "create an sfx, instrument or song",
  usage: "new sfx|instrument|song <id> [flags]",
};
