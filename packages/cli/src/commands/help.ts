import { type FlagSpec, GLOBAL_FLAGS } from "../args.ts";
import {
  FORMAT_SECTIONS,
  FORMAT_TEXT,
  type FormatSection,
  WORKFLOW_TEXT,
} from "../help-text.ts";
import { CliError, closest, table } from "../output.ts";
import type { CommandSpec } from "./types.ts";

function flagLabel(f: FlagSpec): string {
  const names = `${f.alias ? `-${f.alias}, ` : ""}--${f.name}${f.type === "boolean" ? "" : ` ${f.valueName ?? "<value>"}`}`;
  return names;
}

function flagRows(flags: readonly FlagSpec[]): string[][] {
  return flags.map((f) => [
    `  ${flagLabel(f)}`,
    `${f.description}${f.default ? ` (default: ${f.default})` : ""}`,
  ]);
}

const WHITESPACE_RE = /\s+/;

function wrap(text: string, width = 96): string {
  const words = text.split(WHITESPACE_RE);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + w).length + 1 > width && line) {
      lines.push(line.trimEnd());
      line = "";
    }
    line += `${w} `;
  }
  if (line.trim()) {
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}

export function commandHelp(spec: CommandSpec): string {
  const parts = [
    `bleepkit ${spec.usage}`,
    "",
    wrap(spec.description ?? spec.summary),
  ];
  if (spec.flags.length > 0) {
    parts.push("", "Flags:", table(flagRows(spec.flags)));
  }
  parts.push(
    "",
    "Global flags:",
    table(flagRows(GLOBAL_FLAGS)),
    "",
    "Examples:",
    ...spec.examples.map((e) => `  ${e}`)
  );
  return parts.join("\n");
}

export function overview(
  commands: readonly CommandSpec[],
  version: string
): string {
  const rows = commands.map((c) => [`  ${c.name}`, c.summary]);
  return [
    `bleepkit ${version}: generate 80s and 90s game audio from JSON documents and MML`,
    "",
    "Usage: bleepkit <command> [args] [flags]",
    "",
    "Commands:",
    table(rows),
    "",
    "Global flags:",
    table(flagRows(GLOBAL_FLAGS)),
    "",
    "Exit codes: 0 ok, 1 bad result (validation errors, --strict clipping), 2 usage, 3 no project, 4 not found,",
    "            5 encode or write failure, 6 server could not bind. With --json errors look like",
    '            {"ok":false,"error":{"code":"usage|no-project|not-found|invalid|encode|write|bind","message":"...","hint":"..."}}',
    "",
    "First time (or an agent in a fresh session):",
    "  bleepkit help formats      the JSON document formats and MML in one page",
    "  bleepkit help workflow     how to work without hearing the audio",
    "  bleepkit init              create ./audio, then: bleepkit render --analyze",
    "Every command has an example: bleepkit <command> --help",
  ].join("\n");
}

export function buildHelpCommand(all: () => CommandSpec[]): CommandSpec {
  return {
    description:
      "Shows help. `help` lists the commands, `help <command>` explains one (same as `<command> --help`), " +
      "`help formats [section]` prints the JSON document formats, the MML syntax and the effect codes " +
      `(sections: ${FORMAT_SECTIONS.join(", ")}), and \`help workflow\` describes the measure-and-iterate loop for working without listening.`,
    examples: [
      "bleepkit help formats",
      "bleepkit help formats mml",
      "bleepkit help render",
      "bleepkit help workflow --json",
    ],
    flags: [],
    name: "help",
    noProject: true,
    run: (ctx, args) => {
      const [topic, sub] = args.positionals;
      const commands = all();
      if (!topic) {
        const text = overview(commands, ctx.version);
        return {
          human: text,
          json: {
            commands: commands.map((c) => ({
              name: c.name,
              summary: c.summary,
              usage: c.usage,
            })),
            ok: true,
            text,
            topic: "overview",
          },
        };
      }
      if (topic === "formats") {
        const section = (sub ?? "overview") as FormatSection;
        if (!FORMAT_SECTIONS.includes(section)) {
          throw new CliError("usage", `unknown formats section "${sub}"`, {
            hint: `Sections: ${FORMAT_SECTIONS.join(", ")}. Example: bleepkit help formats song`,
          });
        }
        const text = sub
          ? FORMAT_TEXT[section]
          : FORMAT_SECTIONS.map((s) => FORMAT_TEXT[s]).join("\n\n");
        return {
          human: text,
          json: {
            ok: true,
            section: sub ?? "all",
            sections: [...FORMAT_SECTIONS],
            text,
            topic: "formats",
          },
        };
      }
      if (topic === "workflow") {
        return {
          human: WORKFLOW_TEXT,
          json: { ok: true, text: WORKFLOW_TEXT, topic: "workflow" },
        };
      }
      const spec = commands.find((c) => c.name === topic);
      if (!spec) {
        const guess = closest(topic, [
          ...commands.map((c) => c.name),
          "formats",
          "workflow",
        ]);
        throw new CliError("usage", `no help topic "${topic}"`, {
          hint: guess
            ? `Did you mean "${guess}"? Run \`bleepkit help\` for the list.`
            : "Run `bleepkit help` for the list of commands.",
        });
      }
      const text = commandHelp(spec);
      return { human: text, json: { ok: true, text, topic: spec.name } };
    },
    summary: "help, help formats (JSON and MML reference), help workflow",
    usage: "help [formats [section] | workflow | <command>]",
  };
}
