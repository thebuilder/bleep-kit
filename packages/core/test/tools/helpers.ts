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

/** The decoded pixels of a PNG written without a deflate function (stored blocks), parsed by hand. */
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

let crcTable: number[] | null = null;

export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
      }
      crcTable.push(c >>> 0);
    }
  }
  let c = 0xff_ff_ff_ff;
  for (const b of bytes) {
    c = (crcTable[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xff_ff_ff_ff) >>> 0;
}

export function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const v of bytes) {
    a = (a + v) % 65_521;
    b = (b + a) % 65_521;
  }
  return ((b << 16) | a) >>> 0;
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

/** Walk the chunks, checking every CRC; returns the size, the chunk names and the joined IDAT bytes. */
function readChunks(png: Uint8Array): {
  width: number;
  height: number;
  chunks: string[];
  zlib: Uint8Array;
} {
  for (let i = 0; i < 8; i += 1) {
    if (png[i] !== PNG_SIGNATURE[i]) {
      throw new Error("bad PNG signature");
    }
  }
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  const chunks: string[] = [];
  while (at < png.length) {
    const len = u32(png, at);
    const type = chunkType(png, at + 4);
    const body = png.subarray(at + 8, at + 8 + len);
    if (u32(png, at + 8 + len) !== crc32(png.subarray(at + 4, at + 8 + len))) {
      throw new Error(`bad CRC in ${type}`);
    }
    chunks.push(type);
    if (type === "IHDR") {
      width = u32(body, 0);
      height = u32(body, 4);
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) {
        throw new Error("expected 8 bit RGBA, not interlaced");
      }
    } else if (type === "IDAT") {
      idat.push(body);
    }
    at += 12 + len;
  }
  const zlib = new Uint8Array(
    idat.reduce((total, part) => total + part.length, 0)
  );
  let offset = 0;
  for (const part of idat) {
    zlib.set(part, offset);
    offset += part.length;
  }
  return { chunks, height, width, zlib };
}

/** Undo a zlib stream made only of stored blocks and check its Adler-32. */
function inflateStored(z: Uint8Array): Uint8Array {
  if (z[0] !== 0x78 || (((z[0] ?? 0) << 8) | (z[1] ?? 0)) % 31 !== 0) {
    throw new Error("bad zlib header");
  }
  const raw: number[] = [];
  let p = 2;
  let last = false;
  while (!last) {
    const header = z[p] ?? 0;
    if ((header & 6) !== 0) {
      throw new Error("not a stored block");
    }
    last = (header & 1) === 1;
    const len = (z[p + 1] ?? 0) | ((z[p + 2] ?? 0) << 8);
    const nlen = (z[p + 3] ?? 0) | ((z[p + 4] ?? 0) << 8);
    if ((len ^ 0xff_ff) !== nlen) {
      throw new Error("bad stored block length");
    }
    for (let i = 0; i < len; i += 1) {
      raw.push(z[p + 5 + i] ?? 0);
    }
    p += 5 + len;
  }
  const bytes = Uint8Array.from(raw);
  if (u32(z, p) !== adler32(bytes)) {
    throw new Error("bad Adler-32");
  }
  return bytes;
}

/** Parse a PNG of stored deflate blocks: checks the signature, every chunk CRC, the zlib header and Adler-32. */
export function decodeStoredPng(png: Uint8Array): DecodedPng {
  const { chunks, height, width, zlib } = readChunks(png);
  const raw = inflateStored(zlib);
  const rowBytes = width * 4;
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

/** FNV-1a over bytes, for comparing big buffers cheaply. */
export function hashBytes(bytes: Uint8Array): number {
  let h = 0x81_1c_9d_c5;
  for (const b of bytes) {
    h = Math.imul(h ^ b, 0x01_00_01_93);
  }
  return h >>> 0;
}
