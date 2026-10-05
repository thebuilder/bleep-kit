import { fft, ifft, nextPowerOfTwo } from "./spectrum.ts";

export interface PitchPoint {
  /** 0 to 1; 1 minus the YIN aperiodicity. Silent frames score 0. */
  confidence: number;
  /** Fundamental in Hz, or null when the frame is silent or has no clear pitch. */
  hz: number | null;
  /** Seconds at the middle of the analysis window. */
  time: number;
}

export type PitchTrack = PitchPoint[];

export interface PitchOptions {
  hop?: number;
  maxHz?: number;
  minHz?: number;
  window?: number;
}

const DEFAULT_WINDOW = 2048;
const DEFAULT_HOP = 512;
const DEFAULT_MIN_HZ = 30;
const DEFAULT_MAX_HZ = 5000;
/** YIN absolute threshold: a frame is pitched when its normalized difference dips below this. */
const THRESHOLD = 0.2;
/** Frames quieter than this RMS (-60 dBFS) are treated as silence. */
const SILENCE_RMS = 0.001;

interface YinContext {
  aIm: Float64Array;
  aRe: Float64Array;
  bIm: Float64Array;
  bRe: Float64Array;
  cmnd: Float64Array;
  diff: Float64Array;
  prefix: Float64Array;
  sampleRate: number;
  /** Samples in the integration window: window - tauMax. */
  span: number;
  tauMax: number;
  tauMin: number;
  window: number;
}

function createContext(sampleRate: number, opts: PitchOptions): YinContext {
  const window = nextPowerOfTwo(opts.window ?? DEFAULT_WINDOW);
  const minHz = opts.minHz ?? DEFAULT_MIN_HZ;
  const maxHz = opts.maxHz ?? DEFAULT_MAX_HZ;
  const tauMax = Math.max(
    4,
    Math.min(Math.floor(sampleRate / minHz), window / 2)
  );
  const tauMin = Math.max(
    2,
    Math.min(Math.floor(sampleRate / maxHz), tauMax - 2)
  );
  return {
    aIm: new Float64Array(window),
    aRe: new Float64Array(window),
    bIm: new Float64Array(window),
    bRe: new Float64Array(window),
    cmnd: new Float64Array(tauMax + 2),
    diff: new Float64Array(tauMax + 2),
    prefix: new Float64Array(window + 1),
    sampleRate,
    span: window - tauMax,
    tauMax,
    tauMin,
    window,
  };
}

/** d(tau) = sum over j < span of (s[j] - s[j + tau])^2, with the cross term from one FFT correlation. */
function differenceFunction(
  ctx: YinContext,
  signal: Float32Array,
  start: number
): void {
  const { aIm, aRe, bIm, bRe, diff, prefix, span, tauMax, window } = ctx;
  for (let i = 0; i < window; i += 1) {
    const x = signal[start + i] ?? 0;
    bRe[i] = x;
    bIm[i] = 0;
    aRe[i] = i < span ? x : 0;
    aIm[i] = 0;
    prefix[i + 1] = (prefix[i] ?? 0) + x * x;
  }
  fft(aRe, aIm);
  fft(bRe, bIm);
  // correlation r(tau) = IFFT(conj(A) * B)
  for (let k = 0; k < window; k += 1) {
    const ar = aRe[k] ?? 0;
    const ai = aIm[k] ?? 0;
    const br = bRe[k] ?? 0;
    const bi = bIm[k] ?? 0;
    aRe[k] = ar * br + ai * bi;
    aIm[k] = ar * bi - ai * br;
  }
  ifft(aRe, aIm);
  const e0 = prefix[span] ?? 0;
  for (let tau = 0; tau <= tauMax; tau += 1) {
    const shifted = (prefix[span + tau] ?? 0) - (prefix[tau] ?? 0);
    diff[tau] = Math.max(0, e0 + shifted - 2 * (aRe[tau] ?? 0));
  }
}

/** Cumulative mean normalized difference d'(tau); d'(0) = 1. */
function normalizeDifference(ctx: YinContext): void {
  const { cmnd, diff, tauMax } = ctx;
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau += 1) {
    running += diff[tau] ?? 0;
    cmnd[tau] = running > 0 ? ((diff[tau] ?? 0) * tau) / running : 1;
  }
}

/** The first dip below the YIN threshold, followed down to its local minimum. The threshold tightens to within
    0.1 of the deepest dip, so a strong partial (a dip at a fraction of the period) does not beat the fundamental. */
function pickLag(ctx: YinContext): number {
  const { cmnd, tauMax, tauMin } = ctx;
  let deepest = tauMin;
  for (let tau = tauMin; tau <= tauMax; tau += 1) {
    if ((cmnd[tau] ?? 1) < (cmnd[deepest] ?? 1)) {
      deepest = tau;
    }
  }
  const threshold = Math.min(THRESHOLD, (cmnd[deepest] ?? 1) + 0.1);
  for (let tau = tauMin; tau <= tauMax; tau += 1) {
    if ((cmnd[tau] ?? 1) < threshold) {
      let best = tau;
      while (best + 1 <= tauMax && (cmnd[best + 1] ?? 1) < (cmnd[best] ?? 1)) {
        best += 1;
      }
      return best;
    }
  }
  return deepest;
}

/** Parabolic refinement of the lag around its minimum. */
function refineLag(ctx: YinContext, tau: number): number {
  const { diff, tauMax } = ctx;
  if (tau <= 1 || tau >= tauMax) {
    return tau;
  }
  // the raw difference function is closer to a parabola at its minimum than the normalized one
  const a = diff[tau - 1] ?? 0;
  const b = diff[tau] ?? 0;
  const c = diff[tau + 1] ?? 0;
  const denom = a - 2 * b + c;
  if (Math.abs(denom) < 1e-12) {
    return tau;
  }
  return tau + Math.max(-1, Math.min(1, (0.5 * (a - c)) / denom));
}

function frameRms(signal: Float32Array, start: number, count: number): number {
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const x = signal[start + i] ?? 0;
    sum += x * x;
  }
  return Math.sqrt(sum / Math.max(1, count));
}

function analyzeFrame(
  ctx: YinContext,
  signal: Float32Array,
  start: number
): { hz: number | null; confidence: number } {
  if (frameRms(signal, start, ctx.window) < SILENCE_RMS) {
    return { confidence: 0, hz: null };
  }
  differenceFunction(ctx, signal, start);
  normalizeDifference(ctx);
  const tau = pickLag(ctx);
  const aperiodicity = ctx.cmnd[tau] ?? 1;
  const confidence = Math.max(0, Math.min(1, 1 - aperiodicity));
  if (aperiodicity >= THRESHOLD) {
    return { confidence, hz: null };
  }
  return { confidence, hz: ctx.sampleRate / refineLag(ctx, tau) };
}

/** YIN pitch tracking on a mono signal. The lowest pitch it can see is sampleRate / (window / 2) (47 Hz at 2048 and 48 kHz). */
export function trackPitch(
  mono: Float32Array,
  sampleRate: number,
  opts: PitchOptions = {}
): PitchTrack {
  const ctx = createContext(sampleRate, opts);
  const hop = Math.max(1, Math.floor(opts.hop ?? DEFAULT_HOP));
  const track: PitchTrack = [];
  const last = Math.max(0, mono.length - ctx.window);
  for (let start = 0; start <= last; start += hop) {
    const { confidence, hz } = analyzeFrame(ctx, mono, start);
    track.push({ confidence, hz, time: (start + ctx.window / 2) / sampleRate });
  }
  return track;
}

/** One pitch estimate for a short stretch of signal (the scopes use this). */
export function estimatePitch(
  signal: Float32Array,
  start: number,
  sampleRate: number,
  opts: PitchOptions = {}
): { hz: number | null; confidence: number } {
  return analyzeFrame(createContext(sampleRate, opts), signal, start);
}

/** Median of the pitched frames of a track, or null. */
export function medianPitch(
  track: PitchTrack,
  minConfidence = 0.8
): number | null {
  const values: number[] = [];
  for (const p of track) {
    if (p.hz !== null && p.confidence >= minConfidence) {
      values.push(p.hz);
    }
  }
  if (values.length === 0) {
    return null;
  }
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  if (values.length % 2 === 1) {
    return values[mid] ?? null;
  }
  return ((values[mid - 1] ?? 0) + (values[mid] ?? 0)) / 2;
}
