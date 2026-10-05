import fs from "node:fs";
import path from "node:path";
import { CliError, display } from "../output.ts";
import { starterInstruments } from "../presets.ts";
import { serializeDoc, toPosix, writeFileAtomic } from "../project.ts";
import {
  CHIP_IDS,
  type ChipId,
  defaultProject,
  deriveSeed,
  generateSfx,
  normalizeProject,
  normalizeSfx,
} from "../stubs.ts";
import type { CommandSpec } from "./types.ts";

const SEPARATOR_RE = /[-_\s]+/;

function titleCase(s: string): string {
  return s
    .split(SEPARATOR_RE)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

export const initCommand: CommandSpec = {
  description:
    "Creates the project folder (default ./audio) with project.json, empty sfx/ instruments/ songs/ out/ folders, a " +
    ".gitignore holding out/, three starter instruments (lead, bass, drums) and one starter sfx (coin) for the chip. " +
    "Refuses to touch an existing project unless --force, which overwrites the files init itself writes.",
  examples: [
    "bleepkit init",
    'bleepkit init game/audio --chip genesis --name "Deep Reach"',
  ],
  flags: [
    {
      default: "nes",
      description: `chip for the project and its starter documents: ${CHIP_IDS.join(", ")}`,
      name: "chip",
      type: "string",
      valueName: "<chip>",
      values: CHIP_IDS,
    },
    {
      description: "project name (default: derived from the folder name)",
      name: "name",
      type: "string",
      valueName: "<name>",
    },
    {
      description: "overwrite an existing project.json and starter documents",
      name: "force",
      type: "boolean",
    },
  ],
  name: "init",
  noProject: true,
  run: (ctx, args) => {
    const target = args.positionals[0] ?? ctx.projectFlag ?? "audio";
    const dir = path.resolve(ctx.cwd, target);
    const chip = (args.str("chip") ?? "nes") as ChipId;
    const force = args.bool("force") ?? false;
    const projectFile = path.join(dir, "project.json");
    if (fs.existsSync(projectFile) && !force) {
      throw new CliError(
        "invalid",
        `${display(ctx.cwd, projectFile)} already exists`,
        {
          hint: "Use --force to overwrite the files init writes, or run `bleepkit validate` to check the existing project.",
        }
      );
    }
    const folderName =
      path.basename(dir) === "audio"
        ? path.basename(path.dirname(dir))
        : path.basename(dir);
    const name = args.str("name") ?? (titleCase(folderName) || "Untitled");
    const seed = ctx.seed ?? 1;
    const project = normalizeProject({
      ...defaultProject(name),
      chip,
      name,
      seed,
    }).value;
    const files: string[] = [];
    const put = (rel: string, text: string) => {
      writeFileAtomic(path.join(dir, rel), text);
      files.push(toPosix(rel));
    };
    put("project.json", serializeDoc(project));
    for (const sub of ["sfx", "instruments", "songs", "out"]) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
    }
    put(".gitignore", "out/\n");
    for (const { id, instrument } of starterInstruments(chip)) {
      put(`instruments/${id}.json`, serializeDoc(instrument));
    }
    const coin = normalizeSfx(
      generateSfx("coin", {
        chip,
        name: "Coin",
        seed: deriveSeed(seed, "coin"),
      })
    ).value;
    put("sfx/coin.json", serializeDoc(coin));
    const shown = display(ctx.cwd, dir);
    return {
      human: [
        `Created ${shown}/ for chip ${chip} (${files.length} files):`,
        ...files.map((f) => `  ${f}`),
        "",
        "Next steps:",
        "  bleepkit render --analyze                    hear it in numbers: peak, loudness, pitch",
        "  bleepkit new sfx jump --category jump        generate another sound",
        "  bleepkit help formats                        learn the JSON and MML formats",
        "  bleepkit studio                              open the studio in a browser",
      ].join("\n"),
      json: { dir: shown, files, ok: true, root: dir },
    };
  },
  summary: "create a project folder with starter documents",
  usage: "init [dir] [--chip nes] [--name <s>] [--force]",
};
