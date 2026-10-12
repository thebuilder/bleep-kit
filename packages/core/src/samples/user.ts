/* User samples (architecture.md section 2.9): the PCM inside samples/<id>.json is base64 text, because the engine runs in
   an AudioWorklet where there is no atob or Buffer. Everything here is pure: base64, PCM conversion, resampling, the
   small edits the studio's sample editor makes (trim, normalize, 8 bit) and the import rates per chip. */

import { GENESIS_DAC_RATE } from "../chips/genesis.ts";
import type { ChipId, UserSample } from "../types.ts";
import { FORMAT_VERSION, SAMPLE_MAX_BYTES } from "../types.ts";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i += 1) {
  B64_LOOKUP[B64.charCodeAt(i)] = i;
}

/** Standard base64 with padding. */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const chunk = 3 * 8192;
  for (let o = 0; o < bytes.length; o += chunk) {
    const end = Math.min(bytes.length, o + chunk);
    let s = "";
    let i = o;
    for (; i + 2 < end; i += 3) {
      const n =
        ((bytes[i] ?? 0) << 16) |
        ((bytes[i + 1] ?? 0) << 8) |
        (bytes[i + 2] ?? 0);
      s +=
        (B64[(n >> 18) & 63] ?? "") +
        (B64[(n >> 12) & 63] ?? "") +
        (B64[(n >> 6) & 63] ?? "") +
        (B64[n & 63] ?? "");
    }
    if (end - i === 1) {
      const n = (bytes[i] ?? 0) << 16;
      s += `${B64[(n >> 18) & 63] ?? ""}${B64[(n >> 12) & 63] ?? ""}==`;
    } else if (end - i === 2) {
      const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
      s += `${B64[(n >> 18) & 63] ?? ""}${B64[(n >> 12) & 63] ?? ""}${B64[(n >> 6) & 63] ?? ""}=`;
    }
    parts.push(s);
  }
  return parts.join("");
}

const B64_SHAPE = /^[A-Za-z0-9+/]*={0,2}$/;

/** True when `text` is well formed base64 (length a multiple of 4, padding only at the end). */
export function isBase64(text: string): boolean {
  return text.length % 4 === 0 && B64_SHAPE.test(text);
}

/** How many bytes a base64 string decodes to, without decoding it. */
export function base64ByteLength(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let pad = 0;
  if (text.endsWith("==")) {
    pad = 2;
  } else if (text.endsWith("=")) {
    pad = 1;
  }
  return (text.length / 4) * 3 - pad;
}

/** Decode base64. Characters outside the alphabet are skipped, so a damaged string still gives its readable part. */
export function base64ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    const v = c < 128 ? (B64_LOOKUP[c] ?? -1) : -1;
    if (v < 0) {
      continue;
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n] = (acc >> bits) & 255;
      n += 1;
    }
  }
  return out.subarray(0, n);
}

/** Frames in a sample, from its base64 length. */
export function sampleFrames(s: Pick<UserSample, "bits" | "data">): number {
  return Math.floor(base64ByteLength(s.data) / (s.bits === 8 ? 1 : 2));
}

/** The audio as floats in -1..1. 8 bit data is signed (-128..127 over 128), 16 bit is little endian over 32768. */
export function decodeSampleData(
  s: Pick<UserSample, "bits" | "data">
): Float32Array {
  const bytes = base64ToBytes(s.data);
  if (s.bits === 8) {
    const out = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) {
      const b = bytes[i] ?? 0;
      out[i] = (b > 127 ? b - 256 : b) / 128;
    }
    return out;
  }
  const n = Math.floor(bytes.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = (bytes[2 * i] ?? 0) | ((bytes[2 * i + 1] ?? 0) << 8);
    out[i] = (v > 32_767 ? v - 65_536 : v) / 32_768;
  }
  return out;
}

/** Round floats to signed PCM bytes (8 bit: one byte each; 16 bit: little endian pairs). */
export function encodePcm(data: Float32Array, bits: 8 | 16): Uint8Array {
  if (bits === 8) {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
      const v = Math.max(-128, Math.min(127, Math.round((data[i] ?? 0) * 128)));
      out[i] = v & 255;
    }
    return out;
  }
  const out = new Uint8Array(data.length * 2);
  for (let i = 0; i < data.length; i += 1) {
    const v = Math.max(
      -32_768,
      Math.min(32_767, Math.round((data[i] ?? 0) * 32_768))
    );
    out[2 * i] = v & 255;
    out[2 * i + 1] = (v >> 8) & 255;
  }
  return out;
}

export function encodeSampleData(data: Float32Array, bits: 8 | 16): string {
  return bytesToBase64(encodePcm(data, bits));
}

/* ---------- edits ---------- */

/** A sample with the given audio, keeping the metadata of `like` (or the defaults). */
export function sampleFromData(
  data: Float32Array,
  rate: number,
  opts: Partial<Omit<UserSample, "data" | "rate" | "version">> = {}
): UserSample {
  const bits = opts.bits ?? 16;
  return {
    baseNote: opts.baseNote ?? 60,
    bits,
    data: encodeSampleData(data, bits),
    finetune: opts.finetune ?? 0,
    loop: opts.loop ?? null,
    name: opts.name ?? "Sample",
    rate,
    version: FORMAT_VERSION,
    volume: opts.volume ?? 1,
  };
}

/** Peak of the absolute values. */
export function peakOf(data: Float32Array): number {
  let p = 0;
  for (let i = 0; i < data.length; i += 1) {
    const v = Math.abs(data[i] ?? 0);
    if (v > p) {
      p = v;
    }
  }
  return p;
}

/** Scale so the loudest value reaches `target` (default 0.99). A silent sample is returned unchanged. */
export function normalizePeak(data: Float32Array, target = 0.99): Float32Array {
  const p = peakOf(data);
  if (p < 1e-6) {
    return data.slice();
  }
  const g = target / p;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 1) {
    out[i] = (data[i] ?? 0) * g;
  }
  return out;
}

/** Remove a constant offset (the mean). */
export function removeDc(data: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    sum += data[i] ?? 0;
  }
  const mean = data.length > 0 ? sum / data.length : 0;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 1) {
    out[i] = (data[i] ?? 0) - mean;
  }
  return out;
}

/** Round every value to 8 bit, as the Amiga plays it. */
export function quantize8(data: Float32Array): Float32Array {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 1) {
    out[i] =
      Math.max(-128, Math.min(127, Math.round((data[i] ?? 0) * 128))) / 128;
  }
  return out;
}

/** Average the channels of decoded audio (any number) into one mono buffer. */
export function mixToMonoChannels(
  channels: readonly Float32Array[]
): Float32Array {
  const first = channels[0];
  if (!first) {
    return new Float32Array(0);
  }
  if (channels.length === 1) {
    return first.slice();
  }
  const out = new Float32Array(first.length);
  for (const ch of channels) {
    for (let i = 0; i < out.length; i += 1) {
      out[i] = (out[i] ?? 0) + (ch[i] ?? 0);
    }
  }
  const k = 1 / channels.length;
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (out[i] ?? 0) * k;
  }
  return out;
}

/* ---------- resampling ---------- */

const SINC_TAPS = 16;

function sinc(x: number): number {
  if (Math.abs(x) < 1e-9) {
    return 1;
  }
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/**
 * Convert audio from one rate to another with a windowed sinc (Blackman). Going down it lowpasses first, so nothing
 * above the new Nyquist folds back. Pure and deterministic. The result has round(length * to / from) frames.
 */
export function resample(
  data: Float32Array,
  from: number,
  to: number
): Float32Array {
  if (from === to || data.length === 0) {
    return data.slice();
  }
  const ratio = to / from;
  const outLen = Math.max(1, Math.round(data.length * ratio));
  const out = new Float32Array(outLen);
  const cutoff = Math.min(1, ratio);
  const half = SINC_TAPS * Math.max(1, 1 / ratio);
  for (let i = 0; i < outLen; i += 1) {
    const center = i / ratio;
    const lo = Math.max(0, Math.ceil(center - half));
    const hi = Math.min(data.length - 1, Math.floor(center + half));
    let sum = 0;
    let norm = 0;
    for (let j = lo; j <= hi; j += 1) {
      const d = j - center;
      const w =
        0.42 +
        0.5 * Math.cos((Math.PI * d) / half) +
        0.08 * Math.cos((2 * Math.PI * d) / half);
      const k = cutoff * sinc(d * cutoff) * w;
      sum += (data[j] ?? 0) * k;
      norm += k;
    }
    out[i] = norm > 1e-9 ? sum / norm : 0;
  }
  return out;
}

/** Where frame positions land after a resample (loop points follow the audio). */
export function scalePosition(frame: number, from: number, to: number): number {
  return Math.round((frame * to) / from);
}

/* ---------- import rates ---------- */

/**
 * The rate a recording is resampled to on import, by chip. The Amiga plays 8 bit data at 16574 Hz on ProTracker's C-3
 * (period 214) and loses nothing a 4.4 kHz output filter would keep; the Genesis DAC streams 8 bit data at 13 kHz, a
 * driver's usual drum rate (12969 Hz, 276 Z80 cycles per sample); the SNES samples run at 32000 Hz; every other chip
 * keeps the recording up to 32000 Hz so nothing is made worse than it has to be.
 */
export function importRate(chip: ChipId | null, sourceRate: number): number {
  if (chip === "amiga") {
    return 16_574;
  }
  if (chip === "genesis") {
    return Math.round(GENESIS_DAC_RATE);
  }
  if (chip === "snes") {
    return 32_000;
  }
  return Math.max(4000, Math.min(32_000, Math.round(sourceRate)));
}

/** The bit depth a sample is stored in by default for a chip: 8 for the Amiga and the Genesis DAC, 16 elsewhere. */
export function importBits(chip: ChipId | null): 8 | 16 {
  return chip === "amiga" || chip === "genesis" ? 8 : 16;
}

export interface ImportedSample {
  /** What the import changed, in words, for a notice (resampled, mixed to mono, shortened). */
  notes: string[];
  sample: UserSample;
}

/**
 * Turn decoded audio (any channel count, any rate) into a user sample for a chip: mixed to mono, resampled to the
 * chip's import rate, normalized to a 0.99 peak, stored at the chip's bit depth. Longer than the size limit allows
 * is cut (and said so). `baseNote` defaults to 60; `rate` and `bits` replace the chip's own (a lower rate and 8 bit
 * crush a sound on purpose).
 */
export function prepareImport(
  channels: readonly Float32Array[],
  sourceRate: number,
  chip: ChipId | null,
  opts: { baseNote?: number; bits?: 8 | 16; name?: string; rate?: number } = {}
): ImportedSample {
  const notes: string[] = [];
  if (channels.length > 1) {
    notes.push(`mixed ${channels.length} channels to mono`);
  }
  let data = mixToMonoChannels(channels);
  // an explicit rate (the resample action's "crush") replaces the chip's own
  const rate =
    opts.rate === undefined
      ? importRate(chip, sourceRate)
      : Math.max(1000, Math.min(96_000, Math.round(opts.rate)));
  if (rate !== Math.round(sourceRate)) {
    data = resample(data, sourceRate, rate);
    notes.push(`resampled from ${Math.round(sourceRate)} Hz to ${rate} Hz`);
  }
  const bits = opts.bits ?? importBits(chip);
  const maxFrames = Math.floor(SAMPLE_MAX_BYTES / (bits === 8 ? 1 : 2));
  if (data.length > maxFrames) {
    data = data.slice(0, maxFrames);
    notes.push(
      `cut to the first ${(maxFrames / rate).toFixed(1)} seconds (the limit is 2 MiB of audio per sample)`
    );
  }
  data = normalizePeak(removeDc(data));
  const sample = sampleFromData(data, rate, {
    baseNote: opts.baseNote ?? 60,
    bits,
    name: opts.name ?? "Sample",
  });
  return { notes, sample };
}
