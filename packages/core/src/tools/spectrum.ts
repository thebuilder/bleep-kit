// biome-ignore-all lint/suspicious/noBitwiseOperators: the FFT needs bit reversal and power-of-two tests

import { DB_FLOOR } from "./format.ts";

export interface Spectrogram {
  /** Width of one bin in Hz. */
  binHz: number;
  /** size / 2 + 1 bins from 0 Hz to Nyquist. */
  bins: number;
  /** Level of each bin in dBFS (a full scale sine reads 0 dB at its peak bin), frame-major: db[frame * bins + bin]. */
  db: Float32Array;
  frames: number;
  /** Samples between frame starts. */
  hop: number;
  sampleRate: number;
  /** FFT size in samples. */
  size: number;
}

export interface SpectrogramOptions {
  hop?: number;
  size?: number;
}

type Floats = Float32Array | Float64Array;

interface FftPlan {
  cos: Float64Array;
  rev: Uint32Array;
  sin: Float64Array;
  size: number;
}

const plans = new Map<number, FftPlan>();
const DEFAULT_SIZE = 1024;
const DEFAULT_HOP = 256;

export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0;
}

/** Smallest power of two that is at least n (and at least 2). */
export function nextPowerOfTwo(n: number): number {
  let p = 2;
  while (p < n) {
    p *= 2;
  }
  return p;
}

function planFor(size: number): FftPlan {
  const cached = plans.get(size);
  if (cached) {
    return cached;
  }
  const bits = Math.round(Math.log2(size));
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i += 1) {
    cos[i] = Math.cos((2 * Math.PI * i) / size);
    sin[i] = -Math.sin((2 * Math.PI * i) / size);
  }
  const rev = new Uint32Array(size);
  for (let i = 0; i < size; i += 1) {
    let r = 0;
    for (let b = 0; b < bits; b += 1) {
      r = (r << 1) | ((i >> b) & 1);
    }
    rev[i] = r;
  }
  const plan = { cos, rev, sin, size };
  plans.set(size, plan);
  return plan;
}

function bitReverse(re: Floats, im: Floats, rev: Uint32Array): void {
  for (let i = 0; i < re.length; i += 1) {
    const j = rev[i] ?? 0;
    if (j > i) {
      const tr = re[i] ?? 0;
      const ti = im[i] ?? 0;
      re[i] = re[j] ?? 0;
      im[i] = im[j] ?? 0;
      re[j] = tr;
      im[j] = ti;
    }
  }
}

function butterflies(re: Floats, im: Floats, plan: FftPlan): void {
  const n = re.length;
  const { cos, sin } = plan;
  for (let half = 1; half < n; half *= 2) {
    const step = n / (half * 2);
    for (let start = 0; start < n; start += half * 2) {
      for (let k = 0; k < half; k += 1) {
        const wr = cos[k * step] ?? 0;
        const wi = sin[k * step] ?? 0;
        const a = start + k;
        const b = a + half;
        const br = re[b] ?? 0;
        const bi = im[b] ?? 0;
        const xr = br * wr - bi * wi;
        const xi = br * wi + bi * wr;
        re[b] = (re[a] ?? 0) - xr;
        im[b] = (im[a] ?? 0) - xi;
        re[a] = (re[a] ?? 0) + xr;
        im[a] = (im[a] ?? 0) + xi;
      }
    }
  }
}

/** In-place radix-2 FFT (forward, e^-i): re and im have the same power-of-two length. */
export function fft(re: Floats, im: Floats): void {
  const n = re.length;
  if (!isPowerOfTwo(n) || im.length !== n) {
    throw new Error("fft: re and im must have the same power-of-two length");
  }
  const plan = planFor(n);
  bitReverse(re, im, plan.rev);
  butterflies(re, im, plan);
}

/** In-place inverse FFT, scaled by 1 / n. */
export function ifft(re: Floats, im: Floats): void {
  const n = re.length;
  for (let i = 0; i < n; i += 1) {
    im[i] = -(im[i] ?? 0);
  }
  fft(re, im);
  const inv = 1 / n;
  for (let i = 0; i < n; i += 1) {
    re[i] = (re[i] ?? 0) * inv;
    im[i] = -(im[i] ?? 0) * inv;
  }
}

/** Periodic Hann window of n samples (the right shape for spectral analysis). */
export function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  }
  return w;
}

/** Reusable buffers for repeated windowed spectra of one size. */
export interface SpectrumWork {
  /** Multiply |X|^2 by this to get a bin's amplitude squared (a sine of amplitude A peaks at A^2). */
  ampScale: number;
  bins: number;
  im: Float64Array;
  /** Multiply |X|^2 by this for one-sided mean-square power: the bins (DC and Nyquist halved) sum to the signal's mean square. */
  powerScale: number;
  re: Float64Array;
  size: number;
  window: Float32Array;
}

export function createSpectrumWork(size: number): SpectrumWork {
  if (!isPowerOfTwo(size)) {
    throw new Error(`spectrum: size must be a power of two (got ${size})`);
  }
  const window = hann(size);
  let sum = 0;
  let sumSq = 0;
  for (const w of window) {
    sum += w;
    sumSq += w * w;
  }
  return {
    ampScale: (2 / sum) ** 2,
    bins: size / 2 + 1,
    im: new Float64Array(size),
    powerScale: 2 / (size * sumSq),
    re: new Float64Array(size),
    size,
    window,
  };
}

/** Squared FFT magnitude |X|^2 of the Hann windowed samples signal[start .. start + size) (zeros outside the signal) into out. */
export function windowedMagSq(
  work: SpectrumWork,
  signal: Float32Array,
  start: number,
  out: Floats
): void {
  const { im, re, size, window } = work;
  for (let i = 0; i < size; i += 1) {
    const x = signal[start + i];
    re[i] = x === undefined ? 0 : x * (window[i] ?? 0);
    im[i] = 0;
  }
  fft(re, im);
  for (let k = 0; k < work.bins; k += 1) {
    const a = re[k] ?? 0;
    const b = im[k] ?? 0;
    out[k] = a * a + b * b;
  }
}

/** Short time spectrum in dBFS of a mono signal. Frame i covers samples [i * hop, i * hop + size). */
export function spectrogram(
  mono: Float32Array,
  sampleRate: number,
  opts: SpectrogramOptions = {}
): Spectrogram {
  const size = opts.size ?? DEFAULT_SIZE;
  const hop = Math.max(1, Math.floor(opts.hop ?? DEFAULT_HOP));
  const work = createSpectrumWork(size);
  const { bins } = work;
  const frames =
    mono.length <= size ? 1 : Math.floor((mono.length - size) / hop) + 1;
  const db = new Float32Array(frames * bins);
  const mag = new Float64Array(bins);
  for (let f = 0; f < frames; f += 1) {
    windowedMagSq(work, mono, f * hop, mag);
    for (let k = 0; k < bins; k += 1) {
      const p = (mag[k] ?? 0) * work.ampScale;
      db[f * bins + k] =
        p > 0 ? Math.max(DB_FLOOR, 10 * Math.log10(p)) : DB_FLOOR;
    }
  }
  return { binHz: sampleRate / size, bins, db, frames, hop, sampleRate, size };
}
