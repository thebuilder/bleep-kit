/* normalizeSample: samples/<id>.json (architecture.md section 2.10). The audio stays a base64 string; this checks its
   shape and size without decoding it, so a 2 MiB sample validates in about a millisecond. */

import { base64ByteLength, isBase64, sampleFrames } from "../samples/user.ts";
import type { Normalized, UserSample } from "../types.ts";
import { FORMAT_VERSION, SAMPLE_BITS, SAMPLE_MAX_BYTES } from "../types.ts";
import { defaultSample } from "./defaults.ts";
import type { Rec } from "./issues.ts";
import {
  dropUnknown,
  enumField,
  error,
  finish,
  isRec,
  newCtx,
  numField,
  readId,
  readVersion,
  show,
  strField,
  warn,
} from "./issues.ts";
import { migrate } from "./migrate.ts";

const SAMPLE_KEYS = [
  "id",
  "version",
  "name",
  "rate",
  "baseNote",
  "finetune",
  "volume",
  "loop",
  "bits",
  "data",
];

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/** The data string: well formed base64, a whole number of frames, within the size limit. Errors keep the default (empty). */
function readData(
  ctx: ReturnType<typeof newCtx>,
  doc: Rec,
  bits: 8 | 16
): string {
  const v = doc.data;
  const p = "/data";
  if (v === undefined) {
    error(ctx, p, "is required (base64 PCM, mono)");
    return "";
  }
  if (typeof v !== "string") {
    error(ctx, p, `must be a base64 string (was ${show(v)})`);
    return "";
  }
  if (!isBase64(v)) {
    error(
      ctx,
      p,
      "is not valid base64 (standard alphabet, length a multiple of 4, padding only at the end)"
    );
    return "";
  }
  const bytes = base64ByteLength(v);
  if (bytes > SAMPLE_MAX_BYTES) {
    error(
      ctx,
      p,
      `holds ${mib(bytes)} of audio, the limit is ${mib(SAMPLE_MAX_BYTES)} per sample (shorten it, or import at a lower rate)`
    );
    return "";
  }
  if (bytes % (bits === 8 ? 1 : 2) !== 0) {
    error(
      ctx,
      p,
      `holds ${bytes} bytes, which is not a whole number of ${bits} bit frames`
    );
    return "";
  }
  if (bytes === 0) {
    warn(ctx, p, "has no audio");
  }
  return v;
}

function readLoop(
  ctx: ReturnType<typeof newCtx>,
  doc: Rec,
  frames: number
): UserSample["loop"] {
  const v = doc.loop;
  const p = "/loop";
  if (v === undefined || v === null) {
    return null;
  }
  if (!isRec(v)) {
    error(ctx, p, `must be { start, end } in frames or null (was ${show(v)})`);
    return null;
  }
  dropUnknown(ctx, v, p, ["start", "end"]);
  const start = numField(ctx, v, "start", p, {
    def: 0,
    int: true,
    max: Math.max(0, frames),
    min: 0,
    required: true,
  });
  const end = numField(ctx, v, "end", p, {
    def: frames,
    int: true,
    max: Math.max(0, frames),
    min: 0,
    required: true,
  });
  if (end - start < 2) {
    warn(
      ctx,
      p,
      `needs at least 2 frames between start and end (was ${start} to ${end}), the loop was removed`
    );
    return null;
  }
  return { end, start };
}

export function normalizeSample(input: unknown): Normalized<UserSample> {
  const ctx = newCtx();
  if (!isRec(input)) {
    error(ctx, "", `must be an object (was ${show(input)})`);
    return finish(ctx, defaultSample());
  }
  const from = readVersion(ctx, input, FORMAT_VERSION);
  const doc = migrate(input, from);
  dropUnknown(ctx, doc, "", SAMPLE_KEYS);
  const id = readId(ctx, doc);
  const bits = enumField(ctx, doc, "bits", "", SAMPLE_BITS, 16);
  const data = readData(ctx, doc, bits);
  const base = { data, bits };
  const frames = sampleFrames(base);
  const value: UserSample = {
    baseNote: numField(ctx, doc, "baseNote", "", {
      def: 60,
      int: true,
      max: 127,
      min: 0,
    }),
    bits,
    data,
    finetune: numField(ctx, doc, "finetune", "", {
      def: 0,
      max: 100,
      min: -100,
    }),
    loop: readLoop(ctx, doc, frames),
    name: strField(ctx, doc, "name", "", "Sample", { maxLen: 64 }),
    rate: numField(ctx, doc, "rate", "", {
      def: 22_050,
      int: true,
      max: 96_000,
      min: 1000,
    }),
    version: FORMAT_VERSION,
    volume: numField(ctx, doc, "volume", "", { def: 1, max: 1, min: 0 }),
  };
  if (id !== undefined) {
    (value as UserSample & { id?: string }).id = id;
  }
  return finish(ctx, value);
}

/** Warn when the sample cannot be played well on a chip (the size and rate are the same everywhere; this is about use). */
export function sampleFits(sample: UserSample, chip: string): string[] {
  const out: string[] = [];
  const frames = sampleFrames(sample);
  if (chip === "amiga") {
    if (frames > 131_070) {
      out.push(
        `${frames} frames is more than a MOD sample holds (131070); it plays here, but a MOD export would cut it`
      );
    }
    if (sample.bits === 16) {
      out.push(
        "the Amiga plays 8 bit, the sample is rounded to 8 bit when it plays"
      );
    }
  }
  return out;
}
