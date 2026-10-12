/* "Resample": turn a render of any Bleepkit sound (an sfx, an instrument note, a whole song) into a user sample. The
   render is mixed to mono, the silence at both ends is cut, and prepareImport converts it for a chip (its rate, 8 or
   16 bit, a 0.99 peak), so the result is what an imported recording of the same sound would be. `bits: 8` crushes it
   to 8 bit on purpose, a lower `rate` crushes the bandwidth: the sound of a sampler from the 80s and 90s. */

import {
  importBits,
  mixToMonoChannels,
  prepareImport,
} from "../samples/user.ts";
import type { ChipId, RenderResult } from "../types.ts";
import { detectSamplePitch } from "./pitch.ts";

export interface CaptureOptions {
  /** The note the render sounds at (an instrument note rendered at MIDI note 57 sounds at 57). When absent the pitch is
      detected, and a sound with no clear pitch (a drum, a noise) gets 60. */
  baseNote?: number;
  /** Storage bit depth: 8 crushes to 8 bit. Default: the chip's (8 on the Amiga and the Genesis DAC, 16 elsewhere). */
  bits?: 8 | 16;
  /** The chip the sample is for: its rate and bit depth. Null keeps the render's rate (up to 32000 Hz). */
  chip?: ChipId | null;
  name?: string;
  /** Sample rate to store at, 1000 to 96000. A low one (8000 to 11025) adds the grit of an old sampler. */
  rate?: number;
  /** Cut the silence (under -60 dBFS) at the start and the end. Default true. */
  trim?: boolean;
}

export interface Captured {
  /** What was done, in words, for a notice. */
  notes: string[];
  sample: ReturnType<typeof prepareImport>["sample"];
}

const SILENCE = 0.001;
/** Keep a few ms after the last audible frame so the release is not clipped. */
const KEEP_SECONDS = 0.004;

/** The first and one past the last frame above the silence threshold in any channel, or null when it is all silent. */
function audibleSpan(
  channels: readonly Float32Array[],
  rate: number
): { end: number; start: number } | null {
  let start = Number.POSITIVE_INFINITY;
  let end = -1;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i += 1) {
      if (Math.abs(ch[i] ?? 0) > SILENCE) {
        start = Math.min(start, i);
        break;
      }
    }
    for (let i = ch.length - 1; i >= 0; i -= 1) {
      if (Math.abs(ch[i] ?? 0) > SILENCE) {
        end = Math.max(end, i + 1);
        break;
      }
    }
  }
  if (end < 0) {
    return null;
  }
  return { end: end + Math.round(KEEP_SECONDS * rate), start };
}

/** Make a user sample from a render. A silent render gives a one frame sample and says so. */
export function captureSample(
  r: RenderResult,
  opts: CaptureOptions = {}
): Captured {
  const chip = opts.chip ?? null;
  const notes: string[] = [];
  let { channels } = r;
  if (opts.trim !== false) {
    const span = audibleSpan(channels, r.sampleRate);
    if (span === null) {
      notes.push("the render is silent");
      channels = [new Float32Array(2)];
    } else {
      const end = Math.min(span.end, channels[0]?.length ?? 0);
      channels = channels.map((c) => c.slice(span.start, end));
      if (span.start > 0 || end < r.frames) {
        notes.push("cut the silence at the ends");
      }
    }
  }
  const pitch =
    opts.baseNote === undefined
      ? detectSamplePitch(mixToMonoChannels(channels), r.sampleRate)
      : null;
  const baseNote = opts.baseNote ?? pitch?.note ?? 60;
  const imported = prepareImport(channels, r.sampleRate, chip, {
    baseNote,
    ...(opts.bits === undefined ? {} : { bits: opts.bits }),
    ...(opts.name === undefined ? {} : { name: opts.name }),
    ...(opts.rate === undefined ? {} : { rate: opts.rate }),
  });
  const { sample } = imported;
  if (pitch) {
    sample.finetune = Math.max(-100, Math.min(100, -pitch.cents));
    notes.push("pitch detected");
  }
  const bits = opts.bits ?? importBits(chip);
  if (bits === 8) {
    notes.push("8 bit");
  }
  return { notes: [...notes, ...imported.notes], sample };
}
