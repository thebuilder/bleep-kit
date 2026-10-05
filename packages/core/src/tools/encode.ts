import type { RenderResult } from "../types.ts";

export interface OggOptions {
  /** Vorbis VBR quality, -1 (smallest) to 10 (best). Default 6. */
  quality?: number;
  /** Ogg stream serial number. The encoder picks a random one when this is left out, which would make every
      encode differ; Bleepkit pins it so identical input gives identical bytes. Default 0x424c4550. */
  serial?: number;
}

export interface Mp3Options {
  /** Constant bitrate in kbps. Snapped to the nearest value LAME supports (8 to 320). Default 160. */
  bitrate?: number;
}

/** Encoder delay LAME style encoders add at the front of MP3 output, in frames at the encode rate. */
export const MP3_ENCODER_DELAY = 1105;

const CHUNK_FRAMES = 16_384;
const DEFAULT_OGG_QUALITY = 6;
const DEFAULT_OGG_SERIAL = 0x42_4c_45_50;
const DEFAULT_MP3_BITRATE = 160;
const MP3_BITRATES = [
  8, 16, 24, 32, 40, 48, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
] as const;
const MP3_SAMPLE_RATES = [
  8000, 11_025, 12_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000,
] as const;

type Mp3Bitrate = (typeof MP3_BITRATES)[number];
type Mp3Rate = (typeof MP3_SAMPLE_RATES)[number];

/** The slice of the wasm-media-encoders encoder that this module uses. */
interface PcmEncoder {
  encode: (samples: readonly Float32Array[]) => Uint8Array;
  finalize: () => Uint8Array;
}

function nearest<T extends number>(values: readonly T[], target: number): T {
  let best = values[0] as T;
  for (const v of values) {
    if (Math.abs(v - target) < Math.abs(best - target)) {
      best = v;
    }
  }
  return best;
}

function planesOf(r: RenderResult): Float32Array[] {
  const count = r.channels.length;
  if (count < 1 || count > 2) {
    throw new Error(`encode: OGG and MP3 take 1 or 2 channels (got ${count})`);
  }
  return r.channels;
}

function clampChunk(
  src: Float32Array,
  from: number,
  count: number,
  dst: Float32Array
): Float32Array {
  for (let i = 0; i < count; i += 1) {
    const x = src[from + i] ?? 0;
    dst[i] = Math.min(1, Math.max(-1, x));
  }
  return dst.subarray(0, count);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Feed the encoder in fixed chunks (clamped to -1..1) and gather its output. The encoder owns its returned buffers, so copy. */
function runEncoder(
  enc: PcmEncoder,
  planes: Float32Array[],
  frames: number
): Uint8Array {
  const parts: Uint8Array[] = [];
  const scratch = planes.map(() => new Float32Array(CHUNK_FRAMES));
  for (let from = 0; from < frames; from += CHUNK_FRAMES) {
    const n = Math.min(CHUNK_FRAMES, frames - from);
    const chunk = planes.map((src, c) =>
      clampChunk(src, from, n, scratch[c] ?? new Float32Array(n))
    );
    parts.push(enc.encode(chunk).slice());
  }
  parts.push(enc.finalize().slice());
  return concat(parts);
}

/** Encode Ogg Vorbis. Loads wasm-media-encoders on first use. */
export async function encodeOgg(
  r: RenderResult,
  opts: OggOptions = {}
): Promise<Uint8Array> {
  const planes = planesOf(r);
  const { createOggEncoder } = await import("wasm-media-encoders");
  const enc = await createOggEncoder();
  const quality = Math.min(
    10,
    Math.max(-1, opts.quality ?? DEFAULT_OGG_QUALITY)
  );
  enc.configure({
    channels: planes.length === 1 ? 1 : 2,
    oggSerialNo: opts.serial ?? DEFAULT_OGG_SERIAL,
    sampleRate: r.sampleRate,
    vbrQuality: quality,
  });
  return runEncoder(enc, planes, r.frames);
}

/** Encode constant bitrate MP3. Loads wasm-media-encoders on first use. The decoded audio starts MP3_ENCODER_DELAY frames late. */
export async function encodeMp3(
  r: RenderResult,
  opts: Mp3Options = {}
): Promise<Uint8Array> {
  const planes = planesOf(r);
  const { createMp3Encoder } = await import("wasm-media-encoders");
  const enc = await createMp3Encoder();
  const bitrate: Mp3Bitrate = nearest(
    MP3_BITRATES,
    opts.bitrate ?? DEFAULT_MP3_BITRATE
  );
  // Pin the output rate: left alone LAME may pick a lower one at small bitrates.
  const outputSampleRate: Mp3Rate = nearest(MP3_SAMPLE_RATES, r.sampleRate);
  enc.configure({
    bitrate,
    channels: planes.length === 1 ? 1 : 2,
    outputSampleRate,
    sampleRate: r.sampleRate,
  });
  return runEncoder(enc, planes, r.frames);
}
