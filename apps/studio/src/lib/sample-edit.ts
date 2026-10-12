/* Pure edits of a user sample, for the sample editor and its tests: decode the audio once, change it, encode it again.
   A sample is `{ rate, bits, data (base64), loop, ... }`; every edit returns a new sample and keeps the metadata that
   still makes sense (the loop is clamped to the new length). */
import type { Instrument, UserSample } from "./contract.ts";
import {
  decodeSampleData,
  defaultInstrument,
  detectSamplePitch,
  encodeSampleData,
  normalizePeak,
  sampleFrames,
} from "./core.ts";

/** The decoded audio of the sample last asked for. The editor redraws on every drag, and the base64 is megabytes. */
let cached: { data: string; bits: number; floats: Float32Array } | null = null;

/** The audio as floats in -1..1. The array is shared: copy it before changing it. */
export function floatsOf(s: UserSample): Float32Array {
  if (cached && cached.data === s.data && cached.bits === s.bits) {
    return cached.floats;
  }
  const floats = decodeSampleData(s);
  cached = { bits: s.bits, data: s.data, floats };
  return floats;
}

export const framesOf = (s: UserSample): number => sampleFrames(s);

/** `s` with new audio. The loop is kept when it still fits and dropped when it does not. */
function withAudio(
  s: UserSample,
  floats: Float32Array,
  bits: 8 | 16 = s.bits
): UserSample {
  const loop =
    s.loop && s.loop.end <= floats.length && s.loop.end - s.loop.start >= 2
      ? { ...s.loop }
      : null;
  return { ...s, bits, data: encodeSampleData(floats, bits), loop };
}

/** Keep frames [start, end) only; a loop moves with its audio and is cut to what is left. */
export function trimTo(s: UserSample, start: number, end: number): UserSample {
  const all = floatsOf(s);
  const a = Math.max(0, Math.min(all.length - 1, Math.floor(start)));
  const b = Math.max(a + 1, Math.min(all.length, Math.ceil(end)));
  const kept = all.slice(a, b);
  let loop: UserSample["loop"] = null;
  if (s.loop) {
    const ls = Math.max(a, s.loop.start) - a;
    const le = Math.min(b, s.loop.end) - a;
    loop = le - ls >= 2 ? { end: le, start: ls } : null;
  }
  return { ...s, bits: s.bits, data: encodeSampleData(kept, s.bits), loop };
}

/** Scale the audio so its loudest frame reaches 99% of full scale. */
export function normalized(s: UserSample): UserSample {
  return withAudio(s, normalizePeak(floatsOf(s).slice()));
}

/** The same audio stored at another bit depth (8 bit data is what the Amiga plays). */
export function withBits(s: UserSample, bits: 8 | 16): UserSample {
  return s.bits === bits ? s : withAudio(s, floatsOf(s), bits);
}

/** Loudest frame, 0 to 1 (or a little over for float input). */
export function peakLevel(s: UserSample): number {
  let p = 0;
  for (const v of floatsOf(s)) {
    p = Math.max(p, Math.abs(v));
  }
  return p;
}

/**
 * The pitch of the sample as a base note and a finetune. Finetune is how sharp the sample sounds when it plays at its
 * base note, so a sample 20 cents above its note gets -20: the engine subtracts it from the base note.
 */
export function pitchOf(
  s: UserSample
): { baseNote: number; finetune: number; hz: number } | null {
  const p = detectSamplePitch(floatsOf(s), s.rate);
  if (!p) {
    return null;
  }
  return {
    baseNote: p.note,
    finetune: Math.max(-100, Math.min(100, Math.round(-p.cents))),
    hz: p.hz,
  };
}

/** A min and max per pixel column, for drawing: pairs in a Float32Array [min0, max0, min1, max1, ...]. */
export function peaksOf(floats: Float32Array, columns: number): Float32Array {
  const out = new Float32Array(columns * 2);
  const per = floats.length / Math.max(1, columns);
  for (let x = 0; x < columns; x += 1) {
    const from = Math.floor(x * per);
    const to = Math.max(from + 1, Math.floor((x + 1) * per));
    let lo = 0;
    let hi = 0;
    for (let i = from; i < to && i < floats.length; i += 1) {
      const v = floats[i] ?? 0;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    out[2 * x] = lo;
    out[2 * x + 1] = hi;
  }
  return out;
}

/** A sample instrument that plays user sample `id`, for the chip it will be used on. */
export function instrumentFor(
  id: string,
  sample: UserSample,
  chip: Instrument["chip"]
): Instrument {
  const inst = defaultInstrument("sample", chip);
  inst.name = sample.name.slice(0, 64);
  inst.sample = {
    baseNote: sample.baseNote,
    generator: "kick",
    loop: false,
    params: {},
    seed: 1,
    ...(inst.sample ?? {}),
    userSample: id,
  };
  return inst;
}

/** "1.25 s, 22050 Hz, 16 bit mono, 54 KB" */
export function describeSample(s: UserSample): string {
  const frames = sampleFrames(s);
  const bytes = frames * (s.bits === 8 ? 1 : 2);
  const kb =
    bytes < 1024 * 10
      ? `${(bytes / 1024).toFixed(1)}`
      : `${Math.round(bytes / 1024)}`;
  return `${(frames / s.rate).toFixed(2)} s, ${s.rate} Hz, ${s.bits} bit mono, ${kb} KB`;
}
