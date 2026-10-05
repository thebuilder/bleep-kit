/* The numeric fields of an Sfx that generators, randomize and mutate know about, with the hard limits of the document
   type (section 2.2). Category ranges (ranges.ts) narrow these. */
import type { Sfx } from "@bleepkit/core";

export const FIELD_PATHS = [
  "volume",
  "frequency.start",
  "frequency.min",
  "frequency.slide",
  "frequency.deltaSlide",
  "vibrato.depth",
  "vibrato.rate",
  "arpeggio.rate",
  "envelope.attack",
  "envelope.sustain",
  "envelope.punch",
  "envelope.decay",
  "duty.start",
  "duty.sweep",
  "repeat.rate",
  "phaser.offset",
  "phaser.sweep",
  "filter.lowpass",
  "filter.lowpassSweep",
  "filter.resonance",
  "filter.highpass",
  "filter.highpassSweep",
  "bitcrush.bits",
  "bitcrush.rateDivide",
  "fm.ratio",
  "fm.index",
  "fm.indexDecay",
] as const;
export type FieldPath = (typeof FIELD_PATHS)[number];

export interface FieldRange {
  /** Integer fields (bit depth, rate divide). */
  integer?: boolean;
  max: number;
  min: number;
  /** "log" fields (Hz, ratios) are nudged in semitones or multiplicatively, not by addition. */
  scale: "linear" | "log";
}

const lin = (min: number, max: number): FieldRange => ({
  max,
  min,
  scale: "linear",
});
const log = (min: number, max: number): FieldRange => ({
  max,
  min,
  scale: "log",
});
const int = (min: number, max: number): FieldRange => ({
  integer: true,
  max,
  min,
  scale: "linear",
});

/** Limits straight from the Sfx type. */
export const TYPE_LIMITS: Readonly<Record<FieldPath, FieldRange>> = {
  "arpeggio.rate": lin(0, 60),
  "bitcrush.bits": int(1, 16),
  "bitcrush.rateDivide": int(1, 64),
  "duty.start": lin(0, 1),
  "duty.sweep": lin(-4, 4),
  "envelope.attack": lin(0, 2),
  "envelope.decay": lin(0, 3),
  "envelope.punch": lin(0, 1),
  "envelope.sustain": lin(0, 3),
  "filter.highpass": log(20, 10_000),
  "filter.highpassSweep": lin(-8, 8),
  "filter.lowpass": log(50, 20_000),
  "filter.lowpassSweep": lin(-8, 8),
  "filter.resonance": lin(0, 1),
  "fm.index": lin(0, 8),
  "fm.indexDecay": lin(0, 2),
  "fm.ratio": log(0.5, 12),
  "frequency.deltaSlide": lin(-16, 16),
  "frequency.min": log(0, 8000),
  "frequency.slide": lin(-8, 8),
  "frequency.start": log(20, 8000),
  "phaser.offset": lin(-20, 20),
  "phaser.sweep": lin(-40, 40),
  "repeat.rate": lin(0, 60),
  "vibrato.depth": lin(0, 2),
  "vibrato.rate": lin(0, 40),
  volume: lin(0, 1),
};

type Bag = Record<string, unknown>;

function walk(root: unknown, parts: readonly string[]): unknown {
  let node = root;
  for (const part of parts) {
    node = node === null || node === undefined ? null : (node as Bag)[part];
  }
  return node;
}

/** The number at a path, or null when the field is off (null filter, missing fm block). */
export function getField(sfx: Sfx, path: FieldPath): number | null {
  const node = walk(sfx, path.split("."));
  return typeof node === "number" ? node : null;
}

/** Write a number at a path. Does nothing when the parent block is null (an fm field on a non-fm sfx). */
export function setField(sfx: Sfx, path: FieldPath, value: number): void {
  const parts = path.split(".");
  const last = parts.pop() as string;
  const node = walk(sfx, parts);
  if (node !== null && typeof node === "object") {
    (node as Bag)[last] = value;
  }
}

/** Clamp one field to a range (and round integer fields). */
export function clampTo(value: number, range: FieldRange): number {
  const v = Math.min(range.max, Math.max(range.min, value));
  return range.integer ? Math.round(v) : v;
}
