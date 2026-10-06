import fs from "node:fs";
import path from "node:path";
import {
  CHIP_IDS,
  type ChipId,
  type Instrument,
  type Issue,
  midiToSong,
  normalizeInstrument,
  normalizeSong,
  parseMidiMap,
} from "@bleepkit/core";
import { CliError } from "../output.ts";
import {
  checkId,
  docRel,
  openProject,
  type ProjectCtx,
  requireOk,
  writeDoc,
} from "../project.ts";
import { describeSong } from "./describe.ts";
import type { CommandSpec } from "./types.ts";

const NON_ID_RE = /[^a-z0-9]+/g;
const EDGE_DASH_RE = /^-+|-+$/g;
const MIDI_EXT_RE = /\.midi?$/i;
const IMPORT_CHIPS = CHIP_IDS.filter((c) => c !== "custom");

/** `Boss Theme (v2).mid` becomes `boss-theme-v2`. */
function idFromFile(file: string): string {
  const base = path.basename(file).replace(MIDI_EXT_RE, "").toLowerCase();
  const id = base
    .replace(NON_ID_RE, "-")
    .replace(EDGE_DASH_RE, "")
    .slice(0, 64)
    .replace(EDGE_DASH_RE, "");
  return id === "" ? "imported" : id;
}

function readMidi(abs: string, shown: string): Uint8Array {
  try {
    return fs.readFileSync(abs);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    throw CliError.because(
      error,
      code === "ENOENT" ? "not-found" : "write",
      `cannot read ${shown}: ${(error as Error).message}`,
      { hint: "Pass the path of a Standard MIDI file (.mid)." }
    );
  }
}

function chipFor(pc: ProjectCtx, flag: string | undefined): ChipId {
  const chip = (flag ?? pc.project.chip) as ChipId;
  // a custom project has no fixed channels to map onto: fall back to the NES
  return chip === "custom" ? "nes" : chip;
}

function readMap(text: string | undefined): Record<string, string> {
  if (text === undefined) {
    return {};
  }
  const { issues, map } = parseMidiMap(text);
  const [first] = issues;
  if (first) {
    throw new CliError("usage", first.message, {
      hint: 'Example: --map "1=pulse1,2=triangle,10=noise" (MIDI channels 1 to 16, or t2 for a track; - leaves a part out).',
    });
  }
  return map;
}

interface Written {
  created: boolean;
  id: string;
  path: string;
}

/** Writes the instruments the song needs that the project does not have yet; existing ones are kept as they are. */
function writeInstruments(
  pc: ProjectCtx,
  wanted: Record<string, Instrument>
): Written[] {
  const out: Written[] = [];
  for (const [id, raw] of Object.entries(wanted)) {
    const rel = docRel("instrument", id);
    if (fs.existsSync(path.join(pc.root, rel))) {
      out.push({ created: false, id, path: rel });
      continue;
    }
    const n = normalizeInstrument(raw);
    requireOk({ ...n, ref: `instrument/${id}`, rel });
    out.push({
      created: true,
      id,
      path: writeDoc(pc, "instrument", id, n.value),
    });
  }
  return out;
}

function issueLine(i: Issue): string {
  return `  ${i.severity} ${i.path === "" ? "" : `${i.path}: `}${i.message}`;
}

function partLine(p: {
  channel: number;
  name: string | null;
  notes: number;
  ref: string;
  target: string | null;
}): string {
  const label = p.name ? `${p.ref} "${p.name}"` : p.ref;
  return `  ${label}: ${p.notes} notes -> ${p.target ?? "(left out)"}`;
}

export const importCommand: CommandSpec = {
  description:
    "Imports a Standard MIDI File (format 0 or 1) as a song. MIDI channel 10 becomes the chip's drums (noise, a SID noise " +
    "voice, an FM voice, or one sample per drum), the lowest busy part the bass, the busiest high part the lead, and the " +
    "other parts fill the remaining channels. Each channel plays one note at a time: chords keep the top note (the bass " +
    "keeps the lowest), and every note that could not sound is counted in the issues. Notes are rounded to rows " +
    "(--rows-per-beat), velocity becomes the volume column, the tempo comes from the file (later tempo changes become " +
    "tempo effects), and notes move by octaves into each channel's range. Controllers, pitch bend, program changes and " +
    "lyrics are ignored. Writes songs/<id>.json and any new instruments (midi-<chip>-lead, -bass, -drums, -harmony; " +
    "instruments that already exist are kept). --map overrides the automatic placement: MIDI channels (1 to 16), tracks " +
    "(t2) or a track's channel (t2ch1), each to a chip channel id, or - to leave a part out; parts it does not mention " +
    "are placed automatically on the channels it leaves free. The chip is the project's chip unless --chip says " +
    "otherwise.",
  examples: [
    "bleepkit import tune.mid",
    "bleepkit import boss.mid --id boss-theme --chip genesis --rows-per-beat 8",
    'bleepkit import tune.mid --chip nes --map "1=pulse1,2=triangle,10=noise"',
  ],
  flags: [
    {
      description: "song id (default: the file name as an id)",
      name: "id",
      type: "string",
      valueName: "<id>",
    },
    {
      description: `chip (default: the project's chip, nes for a custom project): ${IMPORT_CHIPS.join(", ")}`,
      name: "chip",
      type: "string",
      valueName: "<chip>",
      values: IMPORT_CHIPS,
    },
    {
      default: "4",
      description:
        "rows per quarter note, 1 to 16 (4 is sixteenth notes; use 8 or 12 for finer or triplet timing)",
      name: "rows-per-beat",
      type: "number",
      valueName: "<n>",
    },
    {
      description:
        'which parts go to which chip channels, e.g. "1=pulse1,2=triangle,10=noise" (MIDI channels, tN tracks, - to skip)',
      name: "map",
      type: "string",
      valueName: "<map>",
    },
    {
      description: "label stored in the song (default: the id)",
      name: "name",
      type: "string",
      valueName: "<name>",
    },
    {
      description:
        "the song loops back to the start (default); --no-loop plays it once",
      name: "loop",
      type: "boolean",
    },
    {
      description: "overwrite an existing song with the same id",
      name: "force",
      type: "boolean",
    },
  ],
  name: "import",
  run: (ctx, args) => {
    const [file, ...rest] = args.positionals;
    if (!file || rest.length > 0) {
      throw new CliError(
        "usage",
        "import needs one MIDI file: import <file.mid>",
        {
          hint: "Example: bleepkit import tune.mid --chip nes",
        }
      );
    }
    const id = args.str("id") ?? idFromFile(file);
    checkId(id);
    const pc = openProject(ctx);
    const songRel = docRel("song", id);
    if (!args.bool("force") && fs.existsSync(path.join(pc.root, songRel))) {
      throw new CliError("invalid", `song/${id} already exists (${songRel})`, {
        hint: "Pick another id with --id, or pass --force to overwrite it.",
      });
    }
    const chip = chipFor(pc, args.str("chip"));
    const bytes = readMidi(path.resolve(ctx.cwd, file), file);
    const result = midiToSong(bytes, {
      chip,
      loop: args.bool("loop") ?? true,
      map: readMap(args.str("map")),
      name: args.str("name") ?? id,
      ...(args.num("rows-per-beat") === undefined
        ? {}
        : { rowsPerBeat: args.num("rows-per-beat") as number }),
    });
    const errors = result.issues.filter((i) => i.severity === "error");
    if (errors.length > 0) {
      throw new CliError(
        "invalid",
        `cannot import ${file}:\n${errors.map(issueLine).join("\n")}`,
        {
          details: { issues: result.issues },
          hint: "Check that it is a Standard MIDI file (format 0 or 1), and that --chip, --rows-per-beat and --map are valid.",
        }
      );
    }
    const known = { ...pc.instruments(), ...result.instruments };
    const song = normalizeSong(result.song, known);
    requireOk({ ...song, ref: `song/${id}`, rel: songRel });
    const instruments = writeInstruments(pc, result.instruments);
    const rel = writeDoc(pc, "song", id, song.value);
    const created = instruments.filter((w) => w.created).map((w) => w.id);
    const reused = instruments.filter((w) => !w.created).map((w) => w.id);
    return {
      human: [
        `Imported ${file} as song/${id} (${rel}) for ${chip}`,
        describeSong(song.value),
        "Parts:",
        ...result.parts.map(partLine),
        `Instruments: ${created.length > 0 ? `wrote ${created.join(", ")}` : "none written"}${reused.length > 0 ? `; kept your existing ${reused.join(", ")}` : ""}`,
        ...(result.issues.length > 0
          ? [
              `Lost or changed (${result.issues.length}):`,
              ...result.issues.map(issueLine),
            ]
          : []),
        `Next: bleepkit render song/${id} --analyze --images`,
      ].join("\n"),
      json: {
        chip,
        doc: song.value,
        instruments,
        issues: result.issues,
        ok: true,
        parts: result.parts,
        path: rel,
        root: pc.root,
      },
    };
  },
  summary: "import a MIDI file as a song",
  usage: "import <file.mid> [--id <id>] [--chip <chip>] [flags]",
};
