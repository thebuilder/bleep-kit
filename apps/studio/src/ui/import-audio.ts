/* Importing recordings as user samples: the file picker behind the Samples section, and the conversion of a dropped
   WAV, MP3 or OGG. The file is decoded in the browser, mixed to mono, resampled and quantized for the project's chip
   (core's `prepareImport`, the same code as `bleepkit import sample`), its pitch is detected for the base note, and
   the result is created as a sample document and opened in the sample editor. */
import { app } from "../app.ts";
import {
  AUDIO_ACCEPT,
  type DecodedAudio,
  decodeAudioBytes,
} from "../lib/audio-decode.ts";
import type { ChipId, SampleSource, UserSample } from "../lib/contract.ts";
import {
  chipProfile,
  detectSamplePitch,
  noteName,
  prepareImport,
  scalePosition,
} from "../lib/core.ts";
import { fire, h } from "../lib/dom.ts";
import { instrumentFor } from "../lib/sample-edit.ts";
import { type Doc, project } from "../state/docs.ts";

const EXT = /\.[A-Za-z0-9]+$/;

/** The chip a sample is converted for: the project's, unless it plays no samples of its own kind of format. */
const chipFor = (chip: ChipId): ChipId | null =>
  chip === "custom" ? null : chip;

export interface ImportOptions {
  /** A base note known from elsewhere (a Freesound sound's detected note); it replaces the pitch detection. */
  baseNote?: number | null;
  /** Open the sample editor on the new sample. Default true. */
  open?: boolean;
  /** Who made the recording, when it is not the person's own. */
  source?: SampleSource;
}

/** Make a sample document of decoded audio: mono, resampled and quantized for the project's chip, pitch set. */
export async function importDecodedAudio(
  decoded: DecodedAudio,
  name: string,
  label: string,
  opts: ImportOptions = {}
): Promise<string | null> {
  const [first] = decoded.channels;
  if (!first || first.length < 2) {
    app.toast(`Could not import ${label}: it holds no audio`);
    return null;
  }
  const imported = prepareImport(
    decoded.channels,
    decoded.sampleRate,
    chipFor(project.project.chip),
    { baseNote: 60, name }
  );
  const sample: UserSample = imported.sample;
  const pitch = detectSamplePitch(first, decoded.sampleRate);
  const notes = [...imported.notes];
  if (opts.baseNote !== undefined && opts.baseNote !== null) {
    sample.baseNote = opts.baseNote;
    // the detected pitch only fine tunes a note that agrees with it
    sample.finetune =
      pitch?.note === opts.baseNote
        ? Math.max(-100, Math.min(100, -pitch.cents))
        : 0;
    notes.push(`note ${noteName(opts.baseNote)}`);
  } else if (pitch) {
    sample.baseNote = pitch.note;
    sample.finetune = Math.max(-100, Math.min(100, -pitch.cents));
    notes.push(`pitch ${noteName(pitch.note)}`);
  } else {
    notes.push("no clear pitch, base note C-4");
  }
  if (decoded.loopStart !== undefined && decoded.loopEnd !== undefined) {
    const start = scalePosition(
      decoded.loopStart,
      decoded.sampleRate,
      sample.rate
    );
    const end = scalePosition(decoded.loopEnd, decoded.sampleRate, sample.rate);
    if (end - start >= 2) {
      sample.loop = { end, start };
      notes.push("kept the loop stored in the file");
    }
  }
  if (opts.source) {
    sample.source = opts.source;
  }
  const doc = await project.create(
    "sample",
    project.uniqueId("sample", name),
    sample
  );
  const errors = doc.issues.filter((i) => i.severity === "error");
  if (errors.length > 0) {
    app.toast(`${label}: ${errors[0]?.message ?? "not a valid sample"}`);
  } else {
    app.toast(`Imported ${doc.id}: ${notes.join(", ")}`);
  }
  if (opts.open ?? true) {
    app.navigate(`#/sample/${encodeURIComponent(doc.id)}`);
  }
  return doc.id;
}

/** Import one audio file as a sample document. Resolves to the new sample's id, or null (a notice says why). */
async function importAudioFile(file: File): Promise<string | null> {
  const name = file.name.replace(EXT, "").trim() || "Sample";
  let decoded: DecodedAudio;
  try {
    decoded = await decodeAudioBytes(
      new Uint8Array(await file.arrayBuffer()),
      file.name
    );
  } catch (err) {
    app.toast(`Could not import ${file.name}: ${(err as Error).message}`);
    return null;
  }
  return importDecodedAudio(decoded, name, file.name);
}

/** A sample instrument that plays sample `sampleId`, made for the project's chip. */
export async function createSampleInstrument(
  sampleId: string,
  sample: UserSample,
  id?: string
): Promise<Doc> {
  const { chip } = project.project;
  const forChip = chipProfile(chip).kinds.includes("sample") ? chip : null;
  return await project.create(
    "instrument",
    id ?? project.uniqueId("instrument", sample.name || sampleId),
    instrumentFor(sampleId, sample, forChip)
  );
}

/** Import several files; the last one stays open. */
export async function importAudioFiles(files: readonly File[]): Promise<void> {
  for (const file of files) {
    // biome-ignore lint/performance/noAwaitInLoops: one at a time, so the ids and the notices come in order
    await importAudioFile(file);
  }
}

/** Opens the system file picker for audio files. */
export function pickAudioFiles(): void {
  const input = h("input", {
    accept: AUDIO_ACCEPT,
    multiple: true,
    type: "file",
  });
  input.addEventListener("change", () => {
    const files = Array.from(input.files ?? []);
    if (files.length > 0) {
      fire(importAudioFiles(files));
    }
  });
  input.click();
}
