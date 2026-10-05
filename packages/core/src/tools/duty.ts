import { estimatePitch } from "./pitch.ts";

const WINDOW_SECONDS = 0.1;
const BLOCK_SECONDS = 0.025;
/** A sample is at a level when it is within this share of the block's range from the block's top or bottom. */
const LEVEL_BAND = 0.2;
/** Share of samples that must sit at a level for the signal to count as a two level (pulse) wave. */
const TWO_LEVEL_SHARE = 0.85;
/** Blocks with less swing than this (-40 dBFS peak to peak) are ignored. */
const MIN_RANGE = 0.01;
const SILENCE_PEAK = 0.001;

interface DutyCount {
  high: number;
  levels: number;
  total: number;
}

function countBlock(
  mono: Float32Array,
  from: number,
  to: number,
  acc: DutyCount
): void {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let i = from; i < to; i += 1) {
    const x = mono[i] ?? 0;
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  const range = hi - lo;
  if (range < MIN_RANGE) {
    return;
  }
  const mid = (hi + lo) / 2;
  const band = range * LEVEL_BAND;
  for (let i = from; i < to; i += 1) {
    const x = mono[i] ?? 0;
    acc.total += 1;
    if (x > mid) {
      acc.high += 1;
    }
    if (x >= hi - band || x <= lo + band) {
      acc.levels += 1;
    }
  }
}

function firstAudible(mono: Float32Array): number {
  for (let i = 0; i < mono.length; i += 1) {
    if (Math.abs(mono[i] ?? 0) > SILENCE_PEAK) {
      return i;
    }
  }
  return -1;
}

/** Share of time a pulse wave spends high, measured on the first 100 ms after the sound starts, or null when the
    signal is not a pitched two level wave. The threshold sits halfway between each 25 ms block's top and bottom, so
    DC offsets and decaying envelopes do not matter. */
export function measureDutyCycle(
  mono: Float32Array,
  sampleRate: number
): number | null {
  const start = firstAudible(mono);
  if (start < 0) {
    return null;
  }
  const end = Math.min(
    mono.length,
    start + Math.round(WINDOW_SECONDS * sampleRate)
  );
  const blockLen = Math.max(8, Math.round(BLOCK_SECONDS * sampleRate));
  const acc: DutyCount = { high: 0, levels: 0, total: 0 };
  for (let from = start; from < end; from += blockLen) {
    countBlock(mono, from, Math.min(end, from + blockLen), acc);
  }
  if (
    acc.total < (end - start) / 2 ||
    acc.levels / acc.total < TWO_LEVEL_SHARE
  ) {
    return null;
  }
  if (estimatePitch(mono, start, sampleRate).hz === null) {
    return null;
  }
  return acc.high / acc.total;
}
