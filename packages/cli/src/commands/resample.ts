// `bleepkit resample <ref>`: record what an sfx, a song or an instrument note sounds like as a user sample
// (samples/<id>.json), converted for a chip. The same core code as the studio's Resample button and the assistant's
// resample tool.

import fs from "node:fs";
import path from "node:path";
import {
  CHIP_IDS,
  type ChipId,
  type Instrument,
  normalizeSample,
  noteName,
  renderInstrumentNote,
  renderSfx,
  renderSong,
  type Sfx,
  type Song,
} from "@bleepkit/core";
import { captureSample } from "@bleepkit/core/tools";
import type { Parsed } from "../args.ts";
import { CliError } from "../output.ts";
import {
  checkId,
  docRel,
  instrumentsFor,
  loadDoc,
  openProject,
  requireOk,
  resolveRef,
  samplesFor,
  writeDoc,
} from "../project.ts";
import { idFromName, noteFlag } from "./import-shared.ts";
import type { CommandSpec } from "./types.ts";

const CHIPS = CHIP_IDS.filter((c) => c !== "custom");

function bitsOf(text: number | undefined): 8 | 16 | undefined {
  if (text === undefined) {
    return undefined;
  }
  if (text !== 8 && text !== 16) {
    throw new CliError("usage", `--bits must be 8 or 16 (was ${text})`, {
      hint: "8 crushes the sample to 8 bit.",
    });
  }
  return text;
}

export const resampleCommand: CommandSpec = {
  description:
    "Renders an sfx, a song or one note of an instrument, mixes it to mono, cuts the silence at both ends and stores it " +
    "as a user sample for a chip (amiga and genesis store 8 bit at their own rates). The sample can then be played by a " +
    "sample instrument (`new instrument <id> --kind sample --sample <id>`), on amiga, snes, custom or the Genesis DAC. " +
    "--bits 8 and a low --rate (8000 to 11025) crush it: the sound of an old sampler. For an instrument, --note is the " +
    "note that is played and becomes the sample's base note; for the rest the pitch is detected.",
  examples: [
    "bleepkit resample sfx/explosion --id boom --chip amiga",
    "bleepkit resample instrument/fm-bass --note C-2 --id bass-hit --bits 8",
    "bleepkit resample song/title --id title-loop --rate 11025",
  ],
  flags: [
    {
      description: "sample id (default: the document's id with -sample)",
      name: "id",
      type: "string",
      valueName: "<id>",
    },
    {
      description: `the chip to convert for (default: the project's): ${CHIPS.join(", ")}`,
      name: "chip",
      type: "string",
      valueName: "<chip>",
      values: CHIPS,
    },
    {
      description:
        "instrument: the note to play, like C-4 or 60 (default 60); it becomes the base note",
      name: "note",
      type: "string",
      valueName: "<note>",
    },
    {
      description:
        "instrument: how long the note is held, in seconds (default 0.6)",
      name: "seconds",
      type: "number",
      valueName: "<s>",
    },
    {
      description: "8 crushes to 8 bit (default: what the chip stores)",
      name: "bits",
      type: "number",
      valueName: "<8|16>",
    },
    {
      description: "sample rate to store at, 1000 to 96000",
      name: "rate",
      type: "number",
      valueName: "<hz>",
    },
    {
      description: "label stored in the sample (default: the id)",
      name: "name",
      type: "string",
      valueName: "<name>",
    },
    {
      description: "overwrite an existing sample with the same id",
      name: "force",
      type: "boolean",
    },
  ],
  name: "resample",
  run: (ctx, args: Parsed) => {
    const [refArg, ...more] = args.positionals;
    if (!refArg || more.length > 0) {
      throw new CliError("usage", "resample needs one document reference", {
        hint: "Example: bleepkit resample sfx/explosion --id boom",
      });
    }
    const pc = openProject(ctx);
    const r = resolveRef(pc, refArg, ["sfx", "song", "instrument"]);
    const id = args.str("id") ?? idFromName(`${r.id}-sample`, "sample");
    checkId(id);
    const rel = docRel("sample", id);
    if (!args.bool("force") && fs.existsSync(path.join(pc.root, rel))) {
      throw new CliError("invalid", `sample/${id} already exists (${rel})`, {
        hint: "Pick another id with --id, or pass --force to overwrite it.",
      });
    }
    const chipFlag = args.str("chip") ?? pc.project.chip;
    if (!(CHIP_IDS as readonly string[]).includes(chipFlag)) {
      throw new CliError("usage", `unknown chip "${chipFlag}"`, {
        hint: `Use one of: ${CHIP_IDS.join(", ")}.`,
      });
    }
    const chip = chipFlag === "custom" ? null : (chipFlag as ChipId);
    const note = noteFlag(args.str("note"), "note", "Example: --note C-3");
    const bits = bitsOf(args.num("bits"));
    const rate = args.num("rate");
    const doc = loadDoc(pc, r.kind, r.id);
    requireOk(doc);
    const options = {
      master: pc.project.master,
      sampleRate: 44_100,
      seed: pc.project.seed,
    };
    let render: ReturnType<typeof renderSfx>;
    if (r.kind === "sfx") {
      render = renderSfx(doc.value as Sfx, options);
    } else if (r.kind === "song") {
      const instruments = instrumentsFor(pc, doc.value as Song);
      render = renderSong(doc.value as Song, instruments, {
        ...options,
        samples: samplesFor(pc, instruments),
      });
    } else {
      const inst = doc.value as Instrument;
      render = renderInstrumentNote(inst, note ?? 60, {
        ...options,
        duration: args.num("seconds") ?? 0.6,
        samples: samplesFor(pc, { inst }),
      });
    }
    const captured = captureSample(render, {
      chip,
      name: args.str("name") ?? id,
      ...(r.kind === "instrument" ? { baseNote: note ?? 60 } : {}),
      ...(bits === undefined ? {} : { bits }),
      ...(rate === undefined ? {} : { rate }),
    });
    const n = normalizeSample(captured.sample);
    requireOk({ ...n, ref: `sample/${id}`, rel });
    const written = writeDoc(pc, "sample", id, n.value);
    const s = n.value;
    return {
      human: [
        `Recorded ${r.ref} as sample/${id} (${written}): ${s.bits} bit mono at ${s.rate} Hz, base note ${noteName(s.baseNote)}`,
        ...captured.notes.map((t) => `  ${t}`),
        `Next: bleepkit new instrument <id> --kind sample --sample ${id} --chip ${chip ?? "snes"}`,
      ].join("\n"),
      json: {
        baseNote: s.baseNote,
        bits: s.bits,
        notes: captured.notes,
        ok: true,
        path: written,
        rate: s.rate,
        ref: `sample/${id}`,
        root: pc.root,
      },
    };
  },
  summary: "record an sfx, song or instrument note as a user sample",
  usage: "resample <ref> [flags]",
};
