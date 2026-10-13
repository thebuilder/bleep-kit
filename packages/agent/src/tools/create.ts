// The tools that make new documents the way the CLI's `new` and `mutate` commands do: a generated sound effect, a
// variation of one, a song from MML, an instrument from a preset. Each goes through the same validating `commit`.
import {
  CHIP_IDS,
  type ChipId,
  channelInstrumentIds,
  deriveSeed,
  type Instrument,
  makeInstrument,
  parseMml,
  SFX_CATEGORIES,
  type Sfx,
  type SfxCategory,
  type Song,
} from "@bleepkit/core";
import { describeSfx, generateSfx, mutateSfx } from "@bleepkit/sfx";
import {
  defaultKindFor,
  kindsForChip,
  makeSong,
  PRESETS,
  type Preset,
  planSong,
  type Template,
} from "../author.ts";
import { type AgentHost, refText } from "../host.ts";
import {
  type AgentTool,
  defineTool,
  fail,
  type ToolOutput,
} from "../tool-kit.ts";
import { commit } from "./commit.ts";
import { describeDoc, refOf } from "./documents.ts";

const ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";
const ID_PROP = {
  description: "Lowercase letters, digits and dashes (for example coin-big).",
  pattern: ID_PATTERN,
  type: "string",
} as const;
const CHIP_PROP = {
  description: "Default: the project's chip.",
  enum: CHIP_IDS,
  type: "string",
} as const;

async function nextFreeId(
  host: AgentHost,
  kind: "sfx",
  base: string
): Promise<string> {
  const taken = new Set((await host.list(kind)).map((d) => d.id));
  for (let n = 1; n < 100; n += 1) {
    const id = `${base}-m${n}`.slice(0, 64);
    if (!taken.has(id)) {
      return id;
    }
  }
  return `${base.slice(0, 50)}-m-x`;
}

export function newSfx(host: AgentHost): AgentTool {
  return defineTool<{
    category: SfxCategory;
    chip?: ChipId;
    id: string;
    name?: string;
    replace?: boolean;
    seed?: number;
  }>({
    description:
      "Generate a sound effect with the sfxr-style generator for a category and chip, deterministic for a seed, and save it. A starting point: measure it with render_analyze, then reshape it with edit_document or try variations with mutate_sfx. Refuses an existing id unless replace is true.",
    inputSchema: {
      properties: {
        category: { enum: SFX_CATEGORIES, type: "string" },
        chip: CHIP_PROP,
        id: ID_PROP,
        name: {
          description: "Label shown in the studio.",
          maxLength: 80,
          type: "string",
        },
        replace: {
          description: "Overwrite an existing sfx with this id.",
          type: "boolean",
        },
        seed: {
          description:
            "Same seed, same sound. Default: derived from the project seed and the id.",
          minimum: 0,
          type: "integer",
        },
      },
      required: ["id", "category"],
      type: "object",
    },
    name: "new_sfx",
    run: async (input) => {
      const project = await host.project();
      const chip = input.chip ?? project.chip;
      const seed =
        input.seed ?? deriveSeed(project.seed, `${input.category}:${input.id}`);
      const sfx = generateSfx(input.category, {
        chip,
        name: input.name ?? input.id,
        seed,
      });
      const ref = { id: input.id, kind: "sfx" } as const;
      const { out, value } = await commit(host, ref, sfx, {
        create: !input.replace,
      });
      if (!value) {
        return out;
      }
      return {
        ...out,
        summary: `Created ${refText(ref)} (${chip} ${input.category})`,
        text: `${out.text}\n${describeSfx(value as Sfx)}\nNext: render_analyze ${refText(ref)} to measure it.`,
      };
    },
  });
}

export function mutateSfxTool(host: AgentHost): AgentTool {
  return defineTool<{
    amount?: number;
    count?: number;
    ref: string;
    seed?: number;
  }>({
    description:
      "Make variations of a sound effect (small random nudges of its parameters) and save each as a new sfx, named <id>-m1, -m2... Describes every variant so you can choose without hearing them. The original is not changed.",
    inputSchema: {
      properties: {
        amount: {
          description: "0 to 1, how far to nudge. Default 0.15.",
          maximum: 1,
          minimum: 0.01,
          type: "number",
        },
        count: {
          description: "How many variants, 1 to 4. Default 1.",
          maximum: 4,
          minimum: 1,
          type: "integer",
        },
        ref: {
          description: 'The sound to vary, such as "sfx/coin".',
          type: "string",
        },
        seed: { minimum: 0, type: "integer" },
      },
      required: ["ref"],
      type: "object",
    },
    name: "mutate_sfx",
    run: async (input) => {
      const parsed = refOf(input.ref);
      if (parsed.error) {
        return parsed.error;
      }
      if (parsed.ref.kind !== "sfx") {
        return fail(
          "mutate_sfx: not a sound effect",
          `${refText(parsed.ref)} is not a sound effect: only sfx can be mutated.`
        );
      }
      const original = (await host.read(parsed.ref)) as Sfx | null;
      if (!original) {
        return fail(
          `No ${refText(parsed.ref)}`,
          `There is no ${refText(parsed.ref)}. Call list_documents to see what exists.`
        );
      }
      const seed =
        input.seed ??
        deriveSeed((await host.project()).seed, `mutate:${parsed.ref.id}`);
      const made: string[] = [];
      const lines: string[] = [];
      for (let i = 0; i < (input.count ?? 1); i += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose, each variant takes the next free id
        const id = await nextFreeId(host, "sfx", parsed.ref.id);
        const variant = mutateSfx(original, {
          amount: input.amount ?? 0.15,
          seed: deriveSeed(seed, i),
        });
        const { out, value } = await commit(
          host,
          { id, kind: "sfx" },
          { ...variant, name: `${original.name} ${id.slice(-2)}` },
          { create: true }
        );
        if (!value) {
          lines.push(out.text);
          continue;
        }
        made.push(`sfx/${id}`);
        lines.push(`sfx/${id}: ${describeSfx(value as Sfx)}`);
      }
      return {
        isError: made.length === 0,
        summary:
          made.length > 0
            ? `Mutated ${refText(parsed.ref)} into ${made.join(", ")}`
            : "Mutation failed",
        text: lines.join("\n"),
      };
    },
  });
}

export function newInstrument(host: AgentHost): AgentTool {
  return defineTool<{
    chip?: ChipId;
    id: string;
    kind?: string;
    name?: string;
    preset?: Preset;
    replace?: boolean;
  }>({
    description:
      "Create an instrument from a preset (lead, bass, bass-pulse, drums, pad, bell) for a chip. Songs use instruments by id (a channel's `instrument`, or @id in MML). Refine it afterwards with edit_document (envelope, macros, duty...). Refuses an existing id unless replace is true.",
    inputSchema: {
      properties: {
        chip: CHIP_PROP,
        id: ID_PROP,
        kind: {
          description:
            "Channel kind. Default: the chip's usual voice for the preset (a bass uses the chip's bass voice).",
          type: "string",
        },
        name: { maxLength: 80, type: "string" },
        preset: { enum: PRESETS, type: "string" },
        replace: { type: "boolean" },
      },
      required: ["id"],
      type: "object",
    },
    name: "new_instrument",
    run: async (input) => {
      const chip = input.chip ?? (await host.project()).chip;
      const preset = input.preset ?? "lead";
      const kind = (input.kind ?? defaultKindFor(chip, preset)) as Parameters<
        typeof makeInstrument
      >[0];
      const allowed = kindsForChip(chip);
      if (!allowed.includes(kind)) {
        return fail(
          "new_instrument: kind not on the chip",
          `Chip ${chip} has no ${kind} channels (it has: ${allowed.join(", ")}). Pick one of those, or another chip.`
        );
      }
      const inst = makeInstrument(kind, chip, preset, input.name ?? input.id);
      const ref = { id: input.id, kind: "instrument" } as const;
      const { out, value } = await commit(host, ref, inst, {
        create: !input.replace,
      });
      return value
        ? {
            ...out,
            summary: `Created ${refText(ref)} (${kind} ${preset})`,
            text: `${out.text}\n${describeDoc(ref, value)}\nUse it in MML with @${input.id}, or as a channel's "instrument".`,
          }
        : out;
    },
  });
}

/** Every problem with the MML a song is asked for: a channel the chip does not have, or MML that does not parse. */
function mmlProblems(
  chip: ChipId,
  channelIds: readonly string[],
  mml: Record<string, string>
): string[] {
  const problems: string[] = [];
  for (const [channel, text] of Object.entries(mml)) {
    if (chip !== "custom" && !channelIds.includes(channel)) {
      problems.push(
        `mml.${channel}: the ${chip} chip has no channel "${channel}" (it has: ${channelIds.join(", ")})`
      );
      continue;
    }
    for (const issue of parseMml(text).issues) {
      if (issue.severity === "error") {
        problems.push(`mml.${channel}: ${issue.message}`);
      }
    }
  }
  return problems;
}

/** Apply the model's instrument choices (what the model names wins over what the planner picked). Null when fine. */
function applyChoices(
  song: Song,
  chosen: Record<string, string>,
  channelIds: readonly string[]
): ToolOutput | null {
  for (const [channel, instrument] of Object.entries(chosen)) {
    const target = song.channels.find((c) => c.id === channel);
    if (!target) {
      return fail(
        "new_song: unknown channel",
        `instruments.${channel}: the song has no channel "${channel}" (it has: ${channelIds.join(", ")}).`
      );
    }
    target.instrument = instrument;
  }
  return null;
}

/** The new instruments a song actually plays (the planner makes them before the model's choices replace some). */
function usedCreated(
  song: Song,
  created: Record<string, Instrument>
): Record<string, Instrument> {
  const used = new Set(
    song.channels.flatMap((c) => channelInstrumentIds(song, c))
  );
  return Object.fromEntries(
    Object.entries(created).filter(([id]) => used.has(id))
  );
}

export function newSong(host: AgentHost): AgentTool {
  return defineTool<{
    chip?: ChipId;
    id: string;
    instruments?: Record<string, string>;
    mml: Record<string, string>;
    name?: string;
    replace?: boolean;
    tempo?: number;
    template?: Template;
  }>({
    description:
      'Create a song from MML, one string per channel (channel ids depend on the chip, see chip_info). Each channel that plays notes gets an instrument that fits its chip and kind: one the project has, or a new one made from the per-chip presets (override with `instruments`, or switch inside the MML with @id; an instrument made for another chip is refused). Channels with no notes get none: use the voices of the chip sensibly and leave the rest empty. MML is an input shorthand: the song is saved as tracker patterns (one pattern per four beats, named from `; section: Name` comments, identical bars shared; the L marker becomes the loop), and the result describes those. Timing between rows (triplets, q gates) is kept as a delay Gxx or a cut Sxx on the rows (engine ticks, 1/60 s), the rows per beat do not change. MML syntax is in the system prompt; mistakes come back with the offset of the bad character. Put an "L" in the MML where the song should loop. Refuses an existing id unless replace is true.',
    inputSchema: {
      properties: {
        chip: CHIP_PROP,
        id: ID_PROP,
        instruments: {
          additionalProperties: { type: "string" },
          description:
            'Instrument id per channel, such as {"pulse1": "lead", "noise": "drums"}.',
          type: "object",
        },
        mml: {
          additionalProperties: { type: "string" },
          description:
            'MML per channel id, such as {"pulse1": "t140 o4 l8 cdefgab>c", "triangle": "o2 l4 c g c g"}.',
          type: "object",
        },
        name: { maxLength: 80, type: "string" },
        replace: { type: "boolean" },
        template: {
          description:
            "empty (default) or loop8 (8 empty bars with a loop at the start, for pattern editing).",
          enum: ["empty", "loop8"],
          type: "string",
        },
        tempo: {
          description:
            "Beats per minute, 20 to 400. Default 120 (a `t` command in the MML sets it too).",
          maximum: 400,
          minimum: 20,
          type: "integer",
        },
      },
      required: ["id", "mml"],
      type: "object",
    },
    name: "new_song",
    run: async (input) => {
      const project = await host.project();
      const chip = input.chip ?? project.chip;
      const channelIds = makeSong({
        chip,
        instruments: {},
        mml: {},
        name: input.id,
        template: "empty",
        tempo: 120,
      }).channels.map((c) => c.id);
      const problems = mmlProblems(chip, channelIds, input.mml);
      if (problems.length > 0) {
        return fail(
          "new_song: MML has errors",
          `Nothing was saved:\n${problems.map((p) => `- ${p}`).join("\n")}\nSee the MML section of the system prompt.`
        );
      }
      const plan = planSong({
        chip,
        create: true,
        instruments: await host.instruments(),
        mml: input.mml,
        name: input.name ?? input.id,
        template: input.template ?? "empty",
        tempo: input.tempo ?? 120,
      });
      const { song } = plan;
      const refused = applyChoices(song, input.instruments ?? {}, channelIds);
      if (refused) {
        return refused;
      }
      const made = usedCreated(song, plan.created);
      const ref = { id: input.id, kind: "song" } as const;
      // the whole song is checked before anything is written, so a refusal leaves no stray instruments behind
      const checked = await commit(host, ref, song, {
        create: !input.replace,
        dryRun: true,
        extraInstruments: made,
      });
      if (!checked.value) {
        return checked.out;
      }
      const madeIds = Object.keys(made);
      for (const id of madeIds) {
        // biome-ignore lint/performance/noAwaitInLoops: each instrument is stored in turn, the song after the last
        await commit(host, { id, kind: "instrument" }, made[id], {
          create: true,
        });
      }
      const { out, value } = await commit(host, ref, song, {
        create: !input.replace,
      });
      const newInst =
        madeIds.length > 0
          ? `\nMade ${madeIds.map((id) => `instrument/${id}`).join(", ")} from the ${chip} presets for channels the project had no fitting instrument for.`
          : "";
      return value
        ? {
            ...out,
            summary: `Created ${refText(ref)} (${chip}, ${song.tempo} BPM)`,
            text: `${out.text}${newInst}\n${describeDoc(ref, value)}\nNext: render_analyze ${refText(ref)} to check length, loop and loudness.`,
          }
        : out;
    },
  });
}
