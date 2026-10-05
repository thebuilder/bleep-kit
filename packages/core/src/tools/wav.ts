import type { RenderResult } from "../types.ts";

export interface WavOptions {
  /** Sample format: 16 or 24 bit PCM, or 32 bit IEEE float. Default 16. */
  bits?: 16 | 24 | 32;
  /** Written as ICMT in the LIST INFO chunk (the document id). */
  id?: string;
  /** Written as ISFT, for example "bleepkit 0.1.0". Default "bleepkit". */
  software?: string;
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xff_fe;
const SMPL_HEADER = 36;
const SMPL_LOOP = 24;
const TEXT_CHUNK_ALIGN = 2;

function writeTag(view: DataView, offset: number, tag: string): void {
  for (let i = 0; i < tag.length; i += 1) {
    view.setUint8(offset + i, tag.charCodeAt(i));
  }
}

function readTag(view: DataView, offset: number): string {
  let s = "";
  for (let i = 0; i < 4; i += 1) {
    s += String.fromCharCode(view.getUint8(offset + i));
  }
  return s;
}

/** ASCII bytes of a string, replacing anything outside 0x20..0x7e with "?". */
function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out[i] = code >= 0x20 && code < 0x7f ? code : 0x3f;
  }
  return out;
}

/** One LIST INFO sub-chunk: tag, size, zero terminated text, padded to an even length. */
function infoEntry(tag: string, text: string): Uint8Array {
  const bytes = asciiBytes(text);
  const textLen = bytes.length + 1;
  const padded = textLen + (textLen % TEXT_CHUNK_ALIGN);
  const out = new Uint8Array(8 + padded);
  const view = new DataView(out.buffer);
  writeTag(view, 0, tag);
  view.setUint32(4, textLen, true);
  out.set(bytes, 8);
  return out;
}

function listInfoChunk(opts: WavOptions): Uint8Array {
  const entries: Uint8Array[] = [
    infoEntry("ISFT", opts.software ?? "bleepkit"),
  ];
  if (opts.id !== undefined && opts.id !== "") {
    entries.push(infoEntry("ICMT", opts.id));
  }
  const body = entries.reduce((n, e) => n + e.length, 0);
  const out = new Uint8Array(12 + body);
  const view = new DataView(out.buffer);
  writeTag(view, 0, "LIST");
  view.setUint32(4, 4 + body, true);
  writeTag(view, 8, "INFO");
  let at = 12;
  for (const e of entries) {
    out.set(e, at);
    at += e.length;
  }
  return out;
}

function smplChunk(
  sampleRate: number,
  loopStart: number,
  loopEnd: number
): Uint8Array {
  const out = new Uint8Array(8 + SMPL_HEADER + SMPL_LOOP);
  const view = new DataView(out.buffer);
  writeTag(view, 0, "smpl");
  view.setUint32(4, SMPL_HEADER + SMPL_LOOP, true);
  // manufacturer 0, product 0
  view.setUint32(16, Math.round(1e9 / sampleRate), true); // sample period in ns
  view.setUint32(20, 60, true); // MIDI unity note: C-4
  view.setUint32(36, 1, true); // one loop
  // sampler data 0; the loop: cue id 0, type 0 (forward)
  view.setUint32(8 + SMPL_HEADER + 8, loopStart, true);
  // dwEnd is the last sample played, so the exclusive loopEnd of a RenderResult is stored minus one.
  view.setUint32(8 + SMPL_HEADER + 12, Math.max(loopStart, loopEnd - 1), true);
  return out;
}

function clampInt(v: number, lo: number, hi: number): number {
  if (v < lo) {
    return lo;
  }
  return v > hi ? hi : v;
}

/** Encode PCM 16 or 24 bit, or 32 bit float, with a smpl chunk when r.loopStart is set and a LIST INFO chunk. */
export function encodeWav(r: RenderResult, opts: WavOptions = {}): Uint8Array {
  const bits = opts.bits ?? 16;
  if (bits !== 16 && bits !== 24 && bits !== 32) {
    throw new Error(
      `encodeWav: bits must be 16, 24 or 32 (got ${String(bits)})`
    );
  }
  const channels = r.channels.length;
  if (channels < 1) {
    throw new Error("encodeWav: the render has no channels");
  }
  const { frames } = r;
  const bytesPer = bits / 8;
  const blockAlign = bytesPer * channels;
  const dataBytes = frames * blockAlign;
  const isFloat = bits === 32;

  const loop =
    r.loopStart !== undefined &&
    r.loopEnd !== undefined &&
    r.loopEnd > r.loopStart
      ? smplChunk(r.sampleRate, Math.round(r.loopStart), Math.round(r.loopEnd))
      : null;
  const info = listInfoChunk(opts);
  const fmtSize = isFloat ? 18 : 16;
  const factSize = isFloat ? 12 : 0;
  const dataPad = dataBytes % TEXT_CHUNK_ALIGN;
  const total =
    12 +
    (8 + fmtSize) +
    factSize +
    (8 + dataBytes + dataPad) +
    (loop ? loop.length : 0) +
    info.length;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  writeTag(view, 0, "RIFF");
  view.setUint32(4, total - 8, true);
  writeTag(view, 8, "WAVE");

  let at = 12;
  writeTag(view, at, "fmt ");
  view.setUint32(at + 4, fmtSize, true);
  view.setUint16(at + 8, isFloat ? FORMAT_FLOAT : FORMAT_PCM, true);
  view.setUint16(at + 10, channels, true);
  view.setUint32(at + 12, r.sampleRate, true);
  view.setUint32(at + 16, r.sampleRate * blockAlign, true);
  view.setUint16(at + 20, blockAlign, true);
  view.setUint16(at + 22, bits, true);
  if (isFloat) {
    view.setUint16(at + 24, 0, true);
  }
  at += 8 + fmtSize;

  if (isFloat) {
    writeTag(view, at, "fact");
    view.setUint32(at + 4, 4, true);
    view.setUint32(at + 8, frames, true);
    at += factSize;
  }

  writeTag(view, at, "data");
  view.setUint32(at + 4, dataBytes, true);
  at += 8;
  writeSamples(view, at, r.channels, frames, bits);
  at += dataBytes + dataPad;

  if (loop) {
    out.set(loop, at);
    at += loop.length;
  }
  out.set(info, at);
  return out;
}

function writeSamples(
  view: DataView,
  start: number,
  planes: Float32Array[],
  frames: number,
  bits: number
): void {
  const channels = planes.length;
  let at = start;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const x = planes[c]?.[i] ?? 0;
      if (bits === 16) {
        view.setInt16(
          at,
          clampInt(Math.round(x * 32_768), -32_768, 32_767),
          true
        );
        at += 2;
      } else if (bits === 24) {
        const v = clampInt(Math.round(x * 8_388_608), -8_388_608, 8_388_607);
        view.setUint8(at, v & 0xff);
        view.setUint8(at + 1, (v >> 8) & 0xff);
        view.setUint8(at + 2, (v >> 16) & 0xff);
        at += 3;
      } else {
        view.setFloat32(at, x, true);
        at += 4;
      }
    }
  }
}

interface WavFormat {
  bits: number;
  channels: number;
  format: number;
  sampleRate: number;
}

function readFormat(view: DataView, at: number, size: number): WavFormat {
  if (size < 16) {
    throw new Error("decodeWav: fmt chunk is too short");
  }
  let format = view.getUint16(at, true);
  const channels = view.getUint16(at + 2, true);
  const sampleRate = view.getUint32(at + 4, true);
  const bits = view.getUint16(at + 14, true);
  if (format === FORMAT_EXTENSIBLE && size >= 26) {
    // the first two bytes of the sub-format GUID carry the real format tag
    format = view.getUint16(at + 24, true);
  }
  return { bits, channels, format, sampleRate };
}

function readSample(view: DataView, at: number, fmt: WavFormat): number {
  const { bits, format } = fmt;
  if (format === FORMAT_FLOAT) {
    return bits === 64 ? view.getFloat64(at, true) : view.getFloat32(at, true);
  }
  switch (bits) {
    case 8:
      return (view.getUint8(at) - 128) / 128;
    case 16:
      return view.getInt16(at, true) / 32_768;
    case 24: {
      const raw =
        view.getUint8(at) |
        (view.getUint8(at + 1) << 8) |
        (view.getUint8(at + 2) << 16);
      return (raw & 0x80_00_00 ? raw - 0x1_00_00_00 : raw) / 8_388_608;
    }
    default:
      return view.getInt32(at, true) / 2_147_483_648;
  }
}

interface WavParts {
  dataAt: number;
  dataLen: number;
  fmt: WavFormat;
  loop: { start: number; end: number } | null;
}

function readLoop(
  view: DataView,
  body: number,
  size: number
): WavParts["loop"] {
  if (size < SMPL_HEADER + SMPL_LOOP || view.getUint32(body + 28, true) < 1) {
    return null;
  }
  return {
    end: view.getUint32(body + SMPL_HEADER + 12, true) + 1,
    start: view.getUint32(body + SMPL_HEADER + 8, true),
  };
}

/** Walk the RIFF chunks (clamping sizes that run past the end of the file) and collect fmt, data and smpl. */
function scanChunks(view: DataView, length: number): WavParts {
  let fmt: WavFormat | null = null;
  let dataAt = -1;
  let dataLen = 0;
  let loop: WavParts["loop"] = null;
  let at = 12;
  while (at + 8 <= length) {
    const tag = readTag(view, at);
    const body = at + 8;
    const size = Math.min(view.getUint32(at + 4, true), length - body);
    if (tag === "fmt ") {
      fmt = readFormat(view, body, size);
    } else if (tag === "data") {
      dataAt = body;
      dataLen = size;
    } else if (tag === "smpl") {
      loop = readLoop(view, body, size) ?? loop;
    }
    at = body + size + (size % TEXT_CHUNK_ALIGN);
  }
  if (!fmt) {
    throw new Error("decodeWav: no fmt chunk");
  }
  if (dataAt < 0) {
    throw new Error("decodeWav: no data chunk");
  }
  return { dataAt, dataLen, fmt, loop };
}

function checkFormat(fmt: WavFormat): void {
  if (fmt.format !== FORMAT_PCM && fmt.format !== FORMAT_FLOAT) {
    throw new Error(`decodeWav: unsupported format tag ${fmt.format}`);
  }
  const supported = fmt.format === FORMAT_FLOAT ? [32, 64] : [8, 16, 24, 32];
  if (!supported.includes(fmt.bits)) {
    throw new Error(`decodeWav: unsupported bit depth ${fmt.bits}`);
  }
  if (fmt.channels < 1) {
    throw new Error("decodeWav: zero channels");
  }
}

/** Decode 8/16/24/32 bit PCM and 32/64 bit float WAV (also WAVE_FORMAT_EXTENSIBLE). Reads a smpl loop. The channel count is kept as stored. */
export function decodeWav(bytes: Uint8Array): RenderResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 12 ||
    readTag(view, 0) !== "RIFF" ||
    readTag(view, 8) !== "WAVE"
  ) {
    throw new Error("decodeWav: not a RIFF WAVE file");
  }
  const { dataAt, dataLen, fmt, loop } = scanChunks(view, bytes.length);
  checkFormat(fmt);

  const bytesPer = fmt.bits / 8;
  const frames = Math.floor(dataLen / (bytesPer * fmt.channels));
  const planes: Float32Array[] = [];
  for (let c = 0; c < fmt.channels; c += 1) {
    planes.push(new Float32Array(frames));
  }
  let pos = dataAt;
  for (let i = 0; i < frames; i += 1) {
    for (const plane of planes) {
      plane[i] = readSample(view, pos, fmt);
      pos += bytesPer;
    }
  }

  const result: RenderResult = {
    channels: planes,
    events: [],
    frames,
    sampleRate: fmt.sampleRate,
  };
  if (loop && loop.end > loop.start && loop.start < frames) {
    result.loopStart = loop.start;
    result.loopEnd = Math.min(loop.end, frames);
  }
  return result;
}
