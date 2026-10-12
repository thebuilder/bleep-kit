/* ProTracker MOD reader (architecture.md section 2.10). Pure, dependency free, never throws: a file it cannot read gives
   `file: null` and an error issue. It reads what the format holds (title, 31 samples with finetune, volume and loop,
   the order list with its restart byte, the patterns as period, sample number, effect and parameter) and nothing more. */

import type { Issue } from "../types.ts";

export interface ModSample {
  /** Signed 8 bit audio, length * 2 bytes as the header says (shorter when the file is cut off). */
  data: Int8Array;
  /** -8 to 7 (1/8 semitone steps). */
  finetune: number;
  /** In bytes; a loop of 2 bytes or less means no loop. */
  loopLength: number;
  loopStart: number;
  name: string;
  /** 0 to 64. */
  volume: number;
}

export interface ModCell {
  /** Effect command 0 to 15 and its parameter byte. */
  effect: number;
  param: number;
  /** Amiga period, 0 for no note. */
  period: number;
  /** Sample number 0 to 31, 0 for none. */
  sample: number;
}

export interface ModFile {
  /** 4 for M.K., 6 or 8 for the multichannel tags. */
  channels: number;
  /** Order entries 0 to songLength - 1 matter; the table holds 128 entries. */
  order: number[];
  /** patterns[p][row][channel] */
  patterns: ModCell[][][];
  restart: number;
  samples: ModSample[];
  songLength: number;
  tag: string;
  title: string;
}

export interface ModParse {
  file: ModFile | null;
  issues: Issue[];
}

const HEADER = 1084;
const TAG_OFFSET = 1080;
const ROWS = 64;

const FOUR = new Set(["M.K.", "M!K!", "FLT4", "4CHN", "N.T."]);
const EIGHT = new Set(["8CHN", "OCTA", "OKTA", "CD81"]);
const XXCH = /^(\d\d)CH$/;
const XCHN = /^(\d)CHN$/;

/** Channels a tag stands for, or null when it is not a MOD tag this reader knows. */
export function channelsOfTag(tag: string): number | null {
  if (FOUR.has(tag)) {
    return 4;
  }
  if (EIGHT.has(tag)) {
    return 8;
  }
  const a = XXCH.exec(tag);
  if (a) {
    return Number(a[1]);
  }
  const b = XCHN.exec(tag);
  return b ? Number(b[1]) : null;
}

function text(bytes: Uint8Array, from: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i += 1) {
    const c = bytes[from + i] ?? 0;
    if (c === 0) {
      break;
    }
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : " ";
  }
  return s.trim();
}

function fail(message: string): ModParse {
  return { file: null, issues: [{ message, path: "", severity: "error" }] };
}

function readSamples(bytes: Uint8Array): ModSample[] & { lengths: number[] } {
  const out: ModSample[] = [];
  const lengths: number[] = [];
  for (let i = 0; i < 31; i += 1) {
    const o = 20 + i * 30;
    const words = ((bytes[o + 22] ?? 0) << 8) | (bytes[o + 23] ?? 0);
    const ft = (bytes[o + 24] ?? 0) & 15;
    lengths.push(words * 2);
    out.push({
      data: new Int8Array(0),
      finetune: ft > 7 ? ft - 16 : ft,
      loopLength: (((bytes[o + 28] ?? 0) << 8) | (bytes[o + 29] ?? 0)) * 2,
      loopStart: (((bytes[o + 26] ?? 0) << 8) | (bytes[o + 27] ?? 0)) * 2,
      name: text(bytes, o, 22),
      volume: Math.min(64, bytes[o + 25] ?? 0),
    });
  }
  return Object.assign(out, { lengths });
}

function readOrder(
  bytes: Uint8Array,
  issues: Issue[]
): { length: number; order: number[]; restart: number; top: number } {
  const songLength = bytes[950] ?? 0;
  const order: number[] = [];
  let top = 0;
  for (let i = 0; i < 128; i += 1) {
    const p = Math.min(127, bytes[952 + i] ?? 0);
    order.push(p);
    top = Math.max(top, p);
  }
  if (songLength < 1 || songLength > 128) {
    issues.push({
      message: `the song length is ${songLength}, it should be 1 to 128; playing ${Math.min(128, Math.max(1, songLength))} entries`,
      path: "",
      severity: "warning",
    });
  }
  const length = Math.min(128, Math.max(1, songLength));
  return {
    length,
    order: order.slice(0, length),
    restart: bytes[951] ?? 0,
    top,
  };
}

function readCell(bytes: Uint8Array, o: number): ModCell {
  const b0 = bytes[o] ?? 0;
  const b2 = bytes[o + 2] ?? 0;
  return {
    effect: b2 & 15,
    param: bytes[o + 3] ?? 0,
    period: ((b0 & 15) << 8) | (bytes[o + 1] ?? 0),
    sample: (b0 & 0xf0) | (b2 >> 4),
  };
}

function readPatterns(
  bytes: Uint8Array,
  channels: number,
  top: number
): ModCell[][][] {
  const patterns: ModCell[][][] = [];
  for (let p = 0; p <= top; p += 1) {
    const at = HEADER + p * ROWS * channels * 4;
    const rows: ModCell[][] = [];
    for (let r = 0; r < ROWS; r += 1) {
      const cells: ModCell[] = [];
      for (let c = 0; c < channels; c += 1) {
        cells.push(readCell(bytes, at + (r * channels + c) * 4));
      }
      rows.push(cells);
    }
    patterns.push(rows);
  }
  return patterns;
}

/** Copy each sample's audio out of the bytes after the patterns; cut-off samples keep what the file has. */
function readSampleData(
  bytes: Uint8Array,
  samples: ModSample[] & { lengths: number[] },
  from: number,
  issues: Issue[]
): void {
  let at = from;
  for (let i = 0; i < 31; i += 1) {
    const want = samples.lengths[i] ?? 0;
    const have = Math.max(0, Math.min(want, bytes.length - at));
    const s = samples[i];
    if (s) {
      s.data = new Int8Array(
        bytes.buffer.slice(bytes.byteOffset + at, bytes.byteOffset + at + have)
      );
    }
    if (have < want) {
      issues.push({
        message: `sample ${i + 1} is cut off (${have} of ${want} bytes)`,
        path: `/samples/${i + 1}`,
        severity: "warning",
      });
    }
    at += want;
  }
}

export function parseMod(bytes: Uint8Array): ModParse {
  if (bytes.length < HEADER) {
    return fail(
      `this is ${bytes.length} bytes, too small to be a ProTracker MOD (the header alone is ${HEADER})`
    );
  }
  const raw = String.fromCharCode(
    ...(bytes.subarray(TAG_OFFSET, TAG_OFFSET + 4) as unknown as number[])
  );
  const channels = channelsOfTag(raw);
  if (channels === null) {
    return fail(
      `no ProTracker tag at offset 1080 (found "${text(bytes, TAG_OFFSET, 4)}", expected M.K., 4CHN, 6CHN, 8CHN and the like); 15 sample Soundtracker modules are not supported`
    );
  }
  if (raw === "FLT8") {
    return fail(
      "FLT8 modules store their patterns in pairs and are not supported"
    );
  }
  if (channels < 1 || channels > 32) {
    return fail(`${channels} channels is not a usable MOD`);
  }
  const issues: Issue[] = [];
  const samples = readSamples(bytes);
  const { length, order, restart, top } = readOrder(bytes, issues);
  const patterns = readPatterns(bytes, channels, top);
  const patternsEnd = HEADER + (top + 1) * ROWS * channels * 4;
  if (patternsEnd > bytes.length) {
    issues.push({
      message: `the file ends inside the pattern data (${bytes.length} bytes, ${patternsEnd} needed); the missing cells are empty`,
      path: "",
      severity: "warning",
    });
  }
  readSampleData(bytes, samples, patternsEnd, issues);
  return {
    file: {
      channels,
      order,
      patterns,
      restart,
      samples,
      songLength: length,
      tag: raw,
      title: text(bytes, 0, 20),
    },
    issues,
  };
}
