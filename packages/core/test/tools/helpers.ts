import { crc32, inflateSync } from "node:zlib";
import type { RenderResult } from "../../src/types.ts";

/** Synthetic signals for the tools tests. */

export function sine(
  sampleRate: number,
  seconds: number,
  hz: number,
  amp: number
): Float32Array {
  const n = Math.round(sampleRate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  return out;
}

/** A naive pulse wave: high for `duty` of each period, then low. */
export function pulse(
  sampleRate: number,
  seconds: number,
  hz: number,
  amp: number,
  duty: number
): Float32Array {
  const n = Math.round(sampleRate * seconds);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    out[i] = phase < duty ? amp : -amp;
    phase += hz / sampleRate;
    if (phase >= 1) {
      phase -= 1;
    }
  }
  return out;
}

/** White noise from a small LCG so the tests are deterministic. */
export function noise(
  sampleRate: number,
  seconds: number,
  amp: number,
  seed = 1
): Float32Array {
  const n = Math.round(sampleRate * seconds);
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i += 1) {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    out[i] = amp * ((s / 4_294_967_296) * 2 - 1);
  }
  return out;
}

export function dbToAmp(db: number): number {
  return 10 ** (db / 20);
}

export function render(
  sampleRate: number,
  left: Float32Array,
  right: Float32Array = left,
  extra: Partial<RenderResult> = {}
): RenderResult {
  return {
    channels: [left, right],
    events: [],
    frames: left.length,
    sampleRate,
    ...extra,
  };
}

/** The decoded pixels of a PNG, parsed by hand and inflated with Node's zlib (an independent implementation). */
export interface DecodedPng {
  chunks: string[];
  height: number;
  pixels: Uint8Array;
  width: number;
}

function u32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) * 0x1_00_00_00 +
      ((bytes[at + 1] ?? 0) << 16) +
      ((bytes[at + 2] ?? 0) << 8) +
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunkType(png: Uint8Array, at: number): string {
  return String.fromCharCode(
    png[at] ?? 0,
    png[at + 1] ?? 0,
    png[at + 2] ?? 0,
    png[at + 3] ?? 0
  );
}

/** Walk the chunks, checking the signature, that the chunks end exactly at the end of the file and every CRC (with zlib.crc32). */
export function readPngChunks(png: Uint8Array): {
  width: number;
  height: number;
  chunks: string[];
  idat: Uint8Array;
} {
  for (let i = 0; i < 8; i += 1) {
    if (png[i] !== PNG_SIGNATURE[i]) {
      throw new Error("bad PNG signature");
    }
  }
  let at = 8;
  let width = 0;
  let height = 0;
  const parts: Uint8Array[] = [];
  const chunks: string[] = [];
  while (at < png.length) {
    const len = u32(png, at);
    const type = chunkType(png, at + 4);
    const body = png.subarray(at + 8, at + 8 + len);
    if (at + 12 + len > png.length) {
      throw new Error(`${type} runs past the end of the file`);
    }
    if (u32(png, at + 8 + len) !== crc32(png.subarray(at + 4, at + 8 + len))) {
      throw new Error(`bad CRC in ${type}`);
    }
    chunks.push(type);
    if (type === "IHDR") {
      width = u32(body, 0);
      height = u32(body, 4);
      if (
        body[8] !== 8 ||
        body[9] !== 6 ||
        body[10] !== 0 ||
        body[11] !== 0 ||
        body[12] !== 0
      ) {
        throw new Error(
          "expected 8 bit RGBA, deflate, adaptive filtering, not interlaced"
        );
      }
    } else if (type === "IDAT") {
      parts.push(body);
    }
    at += 12 + len;
  }
  return { chunks, height, idat: concatBytes(parts), width };
}

/** Decode a PNG written by encodePng: every chunk CRC is checked, the IDAT is inflated by zlib (which checks the zlib header and Adler-32) and every scanline must use filter type 0. */
export function decodePng(png: Uint8Array): DecodedPng {
  const { chunks, height, idat, width } = readPngChunks(png);
  const raw = inflateSync(idat);
  const rowBytes = width * 4;
  if (raw.length !== (rowBytes + 1) * height) {
    throw new Error(
      `inflated ${raw.length} bytes, expected ${(rowBytes + 1) * height}`
    );
  }
  const pixels = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    if (raw[y * (rowBytes + 1)] !== 0) {
      throw new Error("expected filter type 0");
    }
    pixels.set(
      raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1)),
      y * rowBytes
    );
  }
  return { chunks, height, pixels, width };
}

/** The RGB at a pixel. */
export function pixelAt(
  img: { width: number; data: Uint8Array },
  x: number,
  y: number
): [number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0];
}

/** Count pixels of exactly this color. */
export function countColor(
  img: { data: Uint8Array },
  rgb: readonly [number, number, number]
): number {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (
      img.data[i] === rgb[0] &&
      img.data[i + 1] === rgb[1] &&
      img.data[i + 2] === rgb[2]
    ) {
      n += 1;
    }
  }
  return n;
}

/** The parts one after the other in a new buffer. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Index of the first byte where two buffers differ (the shorter length when one is a prefix of the other), or -1 when they are equal. */
export function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) {
      return i;
    }
  }
  return a.length === b.length ? -1 : n;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
