/* ITU-R BS.1770 loudness: K-weighting (a high shelf, then a high pass) and block gating.
   Filter coefficients are derived for any sample rate with the bilinear transform, the way libebur128 does. */

interface Biquad {
  a1: number;
  a2: number;
  b0: number;
  b1: number;
  b2: number;
}

const SHELF_HZ = 1681.974_450_955_533;
const SHELF_GAIN_DB = 3.999_843_853_973_347;
const SHELF_Q = 0.707_175_236_955_419_6;
const HIGHPASS_HZ = 38.135_470_876_024_44;
const HIGHPASS_Q = 0.500_327_037_323_877_3;
const BLOCK_SECONDS = 0.4;
const HOP_SECONDS = 0.1;
const HOPS_PER_BLOCK = 4;
const OFFSET_DB = -0.691;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;

function shelf(sampleRate: number): Biquad {
  const k = Math.tan((Math.PI * SHELF_HZ) / sampleRate);
  const vh = 10 ** (SHELF_GAIN_DB / 20);
  const vb = vh ** 0.499_666_774_154_541_6;
  const a0 = 1 + k / SHELF_Q + k * k;
  return {
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / SHELF_Q + k * k) / a0,
    b0: (vh + (vb * k) / SHELF_Q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / SHELF_Q + k * k) / a0,
  };
}

function highPass(sampleRate: number): Biquad {
  const k = Math.tan((Math.PI * HIGHPASS_HZ) / sampleRate);
  const a0 = 1 + k / HIGHPASS_Q + k * k;
  return {
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / HIGHPASS_Q + k * k) / a0,
    b0: 1,
    b1: -2,
    b2: 1,
  };
}

/** Run a signal through the two K-weighting stages (direct form I, doubles). */
function kWeight(
  signal: Float32Array,
  frames: number,
  sampleRate: number
): Float64Array {
  const stages = [shelf(sampleRate), highPass(sampleRate)];
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) {
    out[i] = signal[i] ?? 0;
  }
  for (const s of stages) {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < frames; i += 1) {
      const x = out[i] ?? 0;
      const y = s.b0 * x + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      out[i] = y;
    }
  }
  return out;
}

function toLufs(power: number): number {
  return power > 0
    ? OFFSET_DB + 10 * Math.log10(power)
    : Number.NEGATIVE_INFINITY;
}

/** Mean square of the K-weighted signal in each 100 ms hop, summed over channels. */
function hopPowers(
  planes: Float32Array[],
  frames: number,
  sampleRate: number
): { hops: Float64Array; hopLen: number } {
  const hopLen = Math.max(1, Math.round(HOP_SECONDS * sampleRate));
  const hopCount = Math.floor(frames / hopLen);
  const hops = new Float64Array(hopCount);
  for (const plane of planes) {
    const weighted = kWeight(plane, frames, sampleRate);
    for (let h = 0; h < hopCount; h += 1) {
      let sum = 0;
      for (let i = h * hopLen; i < (h + 1) * hopLen; i += 1) {
        const y = weighted[i] ?? 0;
        sum += y * y;
      }
      hops[h] = (hops[h] ?? 0) + sum / hopLen;
    }
  }
  return { hopLen, hops };
}

function meanAbove(blocks: number[], threshold: number): number {
  let sum = 0;
  let n = 0;
  for (const p of blocks) {
    if (toLufs(p) > threshold) {
      sum += p;
      n += 1;
    }
  }
  return n > 0 ? sum / n : 0;
}

/** Integrated loudness in LUFS: 400 ms blocks every 100 ms, absolute gate at -70 LUFS and relative gate 10 LU
    below the gated mean. Material shorter than one block is measured whole. Silence returns -Infinity. */
export function integratedLufs(
  planes: Float32Array[],
  frames: number,
  sampleRate: number
): number {
  if (frames === 0 || planes.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const blockLen = Math.round(BLOCK_SECONDS * sampleRate);
  if (frames < blockLen) {
    let total = 0;
    for (const plane of planes) {
      const w = kWeight(plane, frames, sampleRate);
      let sum = 0;
      for (const y of w) {
        sum += y * y;
      }
      total += sum / frames;
    }
    return toLufs(total);
  }
  const { hops } = hopPowers(planes, frames, sampleRate);
  const blocks: number[] = [];
  for (let h = 0; h + HOPS_PER_BLOCK <= hops.length; h += 1) {
    let sum = 0;
    for (let k = 0; k < HOPS_PER_BLOCK; k += 1) {
      sum += hops[h + k] ?? 0;
    }
    blocks.push(sum / HOPS_PER_BLOCK);
  }
  const absoluteMean = meanAbove(blocks, ABSOLUTE_GATE_LUFS);
  if (absoluteMean === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const relativeGate = toLufs(absoluteMean) + RELATIVE_GATE_LU;
  const gated = meanAbove(blocks, Math.max(ABSOLUTE_GATE_LUFS, relativeGate));
  return toLufs(gated);
}
