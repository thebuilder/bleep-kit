// `bleepkit import sample <file.wav>` and `bleepkit import song.mod`: the audio side of import. A WAV becomes
// samples/<id>.json (mono, resampled for the chip, embedded as base64); a ProTracker module becomes a song, one
// instrument per used sample and the samples themselves.
import fs from "node:fs";
import path from "node:path";
import {
  CHIP_IDS,
  type ChipId,
  type Issue,
  type ModImport,
  modToSong,
  normalizeSample,
  noteName,
  parseNoteName,
  prepareImport,
  scalePosition,
  type UserSample,
} from "@bleepkit/core";
import { decodeWav, detectSamplePitch, mixToMono } from "@bleepkit/core/tools";
import type { Parsed } from "../args.ts";
import { CliError, type CommandResult, type Ctx } from "../output.ts";
import {
  checkId,
  docRel,
  openProject,
  type ProjectCtx,
  requireOk,
  writeDoc,
} from "../project.ts";

const DIGITS_RE = /^\d+$/;
const NON_ID_RE = /[^a-z0-9]+/g;
const EDGE_DASH_RE = /^-+|-+$/g;
const EXT_RE = /\.[A-Za-z0-9]+$/;

/** `Boss Theme (v2).wav` becomes `boss-theme-v2`. */
export function idFromName(file: string, fallback: string): string {
  const base = path.basename(file).replace(EXT_RE, "").toLowerCase();
  const id = base
    .replace(NON_ID_RE, "-")
    .replace(EDGE_DASH_RE, "")
    .slice(0, 64)
    .replace(EDGE_DASH_RE, "");
  return id === "" ? fallback : id;
}

function readBytes(ctx: Ctx, file: string, what: string): Uint8Array {
  try {
    return fs.readFileSync(path.resolve(ctx.cwd, file));
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    throw CliError.because(
      error,
      code === "ENOENT" ? "not-found" : "write",
      `cannot read ${file}: ${(error as Error).message}`,
      { hint: `Pass the path of ${what}.` }
    );
  }
}

function issueLine(i: Issue): string {
  return `  ${i.severity} ${i.path === "" ? "" : `${i.path}: `}${i.message}`;
}

function section(title: string, issues: Issue[]): string[] {
  return issues.length === 0
    ? []
    : [`${title} (${issues.length}):`, ...issues.map(issueLine)];
}

function chipOf(pc: ProjectCtx, flag: string | undefined): ChipId | null {
  const chip = flag ?? pc.project.chip;
  if (!(CHIP_IDS as readonly string[]).includes(chip)) {
    throw new CliError("usage", `unknown chip "${chip}"`, {
      hint: `Use one of: ${CHIP_IDS.join(", ")}.`,
    });
  }
  return chip === "custom" ? null : (chip as ChipId);
}

function guardFree(
  pc: ProjectCtx,
  kind: "sample" | "song",
  id: string,
  force: boolean
): void {
  const rel = docRel(kind, id);
  if (!force && fs.existsSync(path.join(pc.root, rel))) {
    throw new CliError("invalid", `${kind}/${id} already exists (${rel})`, {
      hint: "Pick another id with --id, or pass --force to overwrite it.",
    });
  }
}

/* ---------- WAV to sample ---------- */

function baseNoteOf(text: string | undefined): number | null {
  if (text === undefined) {
    return null;
  }
  const n = DIGITS_RE.test(text) ? Number(text) : parseNoteName(text);
  if (n === null || n < 0 || n > 127) {
    throw new CliError(
      "usage",
      `--base-note must be a note name like C-4 or A#3, or 0 to 127 (was "${text}")`,
      {
        hint: "Example: --base-note C-4. Leave it out to detect the pitch.",
      }
    );
  }
  return n;
}

function decodeAudio(bytes: Uint8Array, file: string) {
  const lower = file.toLowerCase();
  if (
    lower.endsWith(".mp3") ||
    lower.endsWith(".ogg") ||
    lower.endsWith(".oga")
  ) {
    throw new CliError(
      "invalid",
      `${file} is not a WAV file: the command line imports WAV only`,
      {
        hint: "Convert it to WAV (for example with ffmpeg), or import it in the studio, which also reads MP3 and OGG.",
      }
    );
  }
  try {
    return decodeWav(bytes);
  } catch (error) {
    throw CliError.because(
      error,
      "invalid",
      `${file} cannot be read as a WAV file: ${(error as Error).message}`,
      {
        hint: "Use PCM (8, 16, 24 or 32 bit) or float WAV. The studio also imports MP3 and OGG.",
      }
    );
  }
}

/** Pitch detection fills the base note and finetune; a given --base-note wins. */
function pitchOf(
  mono: Float32Array,
  rate: number,
  given: number | null
): { baseNote: number; finetune: number; note: string } {
  if (given !== null) {
    return {
      baseNote: given,
      finetune: 0,
      note: `base note ${noteName(given)} (given)`,
    };
  }
  const p = detectSamplePitch(mono, rate);
  if (!p) {
    return {
      baseNote: 60,
      finetune: 0,
      note: "no clear pitch found, base note set to C-4 (change it with --base-note)",
    };
  }
  const cents = Math.max(-50, Math.min(50, -p.cents));
  return {
    baseNote: p.note,
    finetune: cents,
    note: `detected ${noteName(p.note)} (${Math.round(p.hz * 10) / 10} Hz${p.cents === 0 ? "" : `, ${p.cents > 0 ? "+" : ""}${p.cents} cents`})`,
  };
}

export function importSample(
  ctx: Ctx,
  args: Parsed,
  file: string
): CommandResult {
  const pc = openProject(ctx);
  const id = args.str("id") ?? idFromName(file, "sample");
  checkId(id);
  guardFree(pc, "sample", id, args.bool("force") ?? false);
  const chip = chipOf(pc, args.str("chip"));
  const wav = decodeAudio(readBytes(ctx, file, "a WAV file"), file);
  const mono = mixToMono(wav);
  const pitch = pitchOf(
    mono,
    wav.sampleRate,
    baseNoteOf(args.str("base-note"))
  );
  const imported = prepareImport(wav.channels, wav.sampleRate, chip, {
    baseNote: pitch.baseNote,
    name: args.str("name") ?? id,
  });
  const sample: UserSample = { ...imported.sample, finetune: pitch.finetune };
  if (
    wav.loopStart !== undefined &&
    wav.loopEnd !== undefined &&
    args.bool("loop") !== false
  ) {
    const start = scalePosition(wav.loopStart, wav.sampleRate, sample.rate);
    const end = scalePosition(wav.loopEnd, wav.sampleRate, sample.rate);
    if (end - start >= 2) {
      sample.loop = { end, start };
      imported.notes.push("kept the loop points stored in the WAV file");
    }
  }
  const n = normalizeSample(sample);
  requireOk({ ...n, ref: `sample/${id}`, rel: docRel("sample", id) });
  const rel = writeDoc(pc, "sample", id, n.value);
  const notes = [pitch.note, ...imported.notes];
  return {
    human: [
      `Imported ${file} as sample/${id} (${rel}): ${n.value.bits} bit mono at ${n.value.rate} Hz`,
      ...notes.map((t) => `  ${t}`),
      `Next: bleepkit new instrument <id> --kind sample --sample ${id} --chip ${chip ?? "snes"}, or pick the sample in the studio.`,
    ].join("\n"),
    json: {
      baseNote: n.value.baseNote,
      doc: { ...n.value, data: undefined },
      finetune: n.value.finetune,
      notes,
      ok: true,
      path: rel,
      root: pc.root,
    },
  };
}

/* ---------- MOD to song ---------- */

function writeAll(
  pc: ProjectCtx,
  id: string,
  result: ModImport,
  force: boolean
): { instruments: string[]; samples: string[]; song: string } {
  for (const sid of Object.keys(result.samples)) {
    guardFree(pc, "sample", sid, force);
  }
  const samples: string[] = [];
  const instruments: string[] = [];
  for (const [sid, sample] of Object.entries(result.samples)) {
    const n = normalizeSample(sample);
    requireOk({ ...n, ref: `sample/${sid}`, rel: docRel("sample", sid) });
    samples.push(writeDoc(pc, "sample", sid, n.value));
  }
  for (const [iid, inst] of Object.entries(result.instruments)) {
    instruments.push(writeDoc(pc, "instrument", iid, inst));
  }
  return { instruments, samples, song: writeDoc(pc, "song", id, result.song) };
}

export function importMod(ctx: Ctx, args: Parsed, file: string): CommandResult {
  const pc = openProject(ctx);
  const id = args.str("id") ?? idFromName(file, "mod");
  checkId(id);
  const force = args.bool("force") ?? false;
  guardFree(pc, "song", id, force);
  const bytes = readBytes(ctx, file, "a ProTracker module (.mod)");
  const separation = args.num("separation");
  const result = modToSong(bytes, {
    id,
    loop: args.bool("loop") ?? true,
    name: args.str("name") ?? id,
    ...(separation === undefined ? {} : { separation }),
  });
  const errors = result.issues.filter((i) => i.severity === "error");
  if (errors.length > 0) {
    throw new CliError(
      "invalid",
      `cannot import ${file}:\n${errors.map(issueLine).join("\n")}`,
      {
        details: { issues: result.issues },
        hint: "Check that it is a ProTracker module (M.K., 4CHN, 6CHN, 8CHN). 15 sample Soundtracker modules and compressed modules are not supported.",
      }
    );
  }
  const written = writeAll(pc, id, result, force);
  const { info } = result;
  return {
    human: [
      `Imported ${file} as song/${id} (${written.song}) for ${result.song.chip}`,
      `Samples: ${written.samples.length} (samples/), instruments: ${written.instruments.length} (instruments/)`,
      ...section(
        "Converted",
        result.issues.filter((i) => i.severity === "info")
      ),
      ...section(
        "Lost or changed",
        result.issues.filter((i) => i.severity !== "info")
      ),
      `Next: bleepkit render song/${id} --analyze --images`,
    ].join("\n"),
    json: {
      chip: result.song.chip,
      info,
      instruments: written.instruments,
      issues: result.issues,
      ok: true,
      path: written.song,
      root: pc.root,
      samples: written.samples,
    },
  };
}
