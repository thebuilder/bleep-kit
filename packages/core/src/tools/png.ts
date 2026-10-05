import { concatBytes } from "./buffers.ts";

/** An RGBA image: data holds width * height * 4 bytes, row by row, top row first. */
export interface PngImage {
  data: Uint8Array;
  height: number;
  width: number;
}

/** Compress a buffer into a zlib stream (RFC 1950), for example `(d) => new Uint8Array(zlib.deflateSync(d))`. */
export type Deflate = (data: Uint8Array) => Uint8Array;

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const STORED_BLOCK_MAX = 0xff_ff;
const ADLER_MOD = 65_521;
const ADLER_CHUNK = 5552;
const CRC_POLY = 0xed_b8_83_20;

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) {
    return crcTable;
  }
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? CRC_POLY ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  const table = getCrcTable();
  let c = 0xff_ff_ff_ff;
  for (let i = start; i < end; i += 1) {
    c = (table[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xff_ff_ff_ff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < bytes.length) {
    const end = Math.min(i + ADLER_CHUNK, bytes.length);
    for (; i < end; i += 1) {
      a += bytes[i] ?? 0;
      b += a;
    }
    a %= ADLER_MOD;
    b %= ADLER_MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/** A valid zlib stream made only of stored (uncompressed) deflate blocks. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / STORED_BLOCK_MAX));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  const view = new DataView(out.buffer);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  let from = 0;
  for (let b = 0; b < blocks; b += 1) {
    const len = Math.min(STORED_BLOCK_MAX, raw.length - from);
    out[at] = b === blocks - 1 ? 1 : 0;
    view.setUint16(at + 1, len, true);
    view.setUint16(at + 3, ~len & 0xff_ff, true);
    out.set(raw.subarray(from, from + len), at + 5);
    at += 5 + len;
    from += len;
  }
  view.setUint32(at, adler32(raw), false);
  return out;
}

function writeChunk(parts: Uint8Array[], type: string, body: Uint8Array): void {
  const chunk = new Uint8Array(12 + body.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, body.length, false);
  for (let i = 0; i < 4; i += 1) {
    chunk[4 + i] = type.charCodeAt(i);
  }
  chunk.set(body, 8);
  view.setUint32(8 + body.length, crc32(chunk, 4, 8 + body.length), false);
  parts.push(chunk);
}

/** Encode 8-bit RGBA PNG. Without `deflate` the pixel data is written as stored blocks (valid, but not compressed). */
export function encodePng(img: PngImage, deflate?: Deflate): Uint8Array {
  const { width, height, data } = img;
  if (
    !(Number.isInteger(width) && Number.isInteger(height)) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error(`encodePng: bad size ${width}x${height}`);
  }
  const rowBytes = width * 4;
  if (data.length < rowBytes * height) {
    throw new Error("encodePng: data is shorter than width * height * 4");
  }
  // every scanline starts with its filter type byte: 0 (none)
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw.set(
      data.subarray(y * rowBytes, (y + 1) * rowBytes),
      y * (rowBytes + 1) + 1
    );
  }
  const idat = deflate ? deflate(raw) : zlibStored(raw);

  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width, false);
  hv.setUint32(4, height, false);
  header[8] = 8; // bit depth
  header[9] = 6; // color type: RGBA
  const parts: Uint8Array[] = [Uint8Array.from(SIGNATURE)];
  writeChunk(parts, "IHDR", header);
  writeChunk(parts, "IDAT", idat);
  writeChunk(parts, "IEND", new Uint8Array(0));

  return concatBytes(parts);
}
