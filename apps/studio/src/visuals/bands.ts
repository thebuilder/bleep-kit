/* The master spectrum's maths, apart from the drawing: log-spaced bands over the FFT's magnitudes, a fixed dB scale,
   and the bar ballistics (fast attack, a smooth release, a peak hold that falls slowly). */

export const SPEC_MIN_HZ = 40;
export const SPEC_MAX_HZ = 16_000;
/** The fixed scale: 0 dBFS is a full-scale sine, the floor is where a bar is empty. No automatic gain. */
export const DB_TOP = 0;
export const DB_FLOOR = -72;
/*
 * The ballistics of every bar and meter in the studio, one set of numbers (strip.ts and level.ts read these):
 * a bar rises with this time constant (seconds) and falls at this many dB per second, so a full 72 dB drop takes
 * about 1.2 s and a typical loud bar (-20 dB) under a second.
 */
export const ATTACK_S = 0.012;
export const RELEASE_DB_S = 60;
/** A peak marker waits this long (ms) after its bar, then falls at this many dB per second. */
export const PEAK_HOLD_MS = 300;
export const PEAK_FALL_DB_S = 40;
/**
 * Once the sound has stopped (the master is silent) bars and peak markers stop holding and fall this fast, so a
 * stopped song clears the display in well under a second (72 dB in 0.6 s).
 */
export const STOP_FALL_DB_S = 120;
/** The master counts as silent below this peak (about -66 dBFS, under the spectrum's floor). */
export const SILENT_PEAK = 5e-4;

/** `count + 1` band edges in Hz, log spaced from `minHz` to `maxHz` (kept below the Nyquist frequency). */
export function bandEdgesHz(
  count: number,
  sampleRate: number,
  minHz = SPEC_MIN_HZ,
  maxHz = SPEC_MAX_HZ
): Float64Array {
  const top = Math.min(maxHz, sampleRate / 2.1);
  const edges = new Float64Array(count + 1);
  for (let i = 0; i <= count; i += 1) {
    edges[i] = minHz * (top / minHz) ** (i / count);
  }
  return edges;
}

/**
 * The level of each band in dBFS from `mag` (the FFT's size / 2 amplitudes, a full-scale sine reads about 1). A band
 * wider than a bin is the energy of the bins it covers (partial bins weighted by overlap); a band narrower than one is
 * read between the two nearest bins, so the low bars follow the curve and do not step.
 */
export function bandLevels(
  mag: Float32Array,
  sampleRate: number,
  edgesHz: Float64Array,
  out: Float32Array
): void {
  const size = mag.length * 2;
  const binHz = sampleRate / size;
  const bands = edgesHz.length - 1;
  for (let b = 0; b < bands; b += 1) {
    const lo = (edgesHz[b] ?? 0) / binHz;
    const hi = (edgesHz[b + 1] ?? 0) / binHz;
    let amp = 0;
    if (hi - lo < 1) {
      const centre = (lo + hi) / 2;
      const k = Math.floor(centre);
      const f = centre - k;
      const a = mag[k] ?? 0;
      amp = a + ((mag[k + 1] ?? a) - a) * f;
    } else {
      let energy = 0;
      for (
        let k = Math.floor(lo);
        k < Math.ceil(hi) && k < mag.length;
        k += 1
      ) {
        const w = Math.min(hi, k + 1) - Math.max(lo, k);
        const m = mag[k] ?? 0;
        energy += Math.max(0, w) * m * m;
      }
      // a Hann window spreads a sine over about 1.5 bins of energy: take that back out
      amp = Math.sqrt(energy / 1.5);
    }
    out[b] = amp < 1e-9 ? DB_FLOOR : clampDb(20 * Math.log10(amp));
  }
}

export function clampDb(db: number): number {
  return Math.max(DB_FLOOR, Math.min(DB_TOP, db));
}

/** 0..1 height of a level on the fixed scale. */
export function dbFraction(db: number): number {
  return (clampDb(db) - DB_FLOOR) / (DB_TOP - DB_FLOOR);
}

export interface Ballistics {
  /** The bars' levels in dB. */
  bars: Float32Array;
  /** performance.now() ms when each peak marker was last pushed up. */
  peakAt: Float64Array;
  /** The peak markers' levels in dB. */
  peaks: Float32Array;
}

export function createBallistics(count: number): Ballistics {
  return {
    bars: new Float32Array(count).fill(DB_FLOOR),
    peakAt: new Float64Array(count),
    peaks: new Float32Array(count).fill(DB_FLOOR),
  };
}

/** One dB fall of a bar or a level over `dt` seconds: the release, or the fast stop fall once the sound is gone. */
export function fallDb(dt: number, silent: boolean): number {
  return (silent ? STOP_FALL_DB_S : RELEASE_DB_S) * dt;
}

/** The attack factor of one `dt` step: how much of the way to a higher target a bar goes. */
export function riseFactor(dt: number): number {
  return 1 - Math.exp(-dt / ATTACK_S);
}

/**
 * One step of `dt` seconds at time `nowMs`: each bar chases its `target` dB. `silent` (the master has stopped)
 * drops the peak hold and makes bars and markers fall at STOP_FALL_DB_S.
 */
export function stepBallistics(
  s: Ballistics,
  target: Float32Array,
  dt: number,
  nowMs: number,
  silent = false
): void {
  const rise = riseFactor(dt);
  const drop = fallDb(dt, silent);
  for (let b = 0; b < s.bars.length; b += 1) {
    const cur = s.bars[b] ?? DB_FLOOR;
    const t = target[b] ?? DB_FLOOR;
    const next = t > cur ? cur + (t - cur) * rise : Math.max(t, cur - drop);
    s.bars[b] = next;
    const peak = s.peaks[b] ?? DB_FLOOR;
    if (next >= peak) {
      s.peaks[b] = next;
      s.peakAt[b] = nowMs;
    } else if (silent || nowMs - (s.peakAt[b] ?? 0) > PEAK_HOLD_MS) {
      const fall = silent ? drop : PEAK_FALL_DB_S * dt;
      s.peaks[b] = Math.max(next, DB_FLOOR, peak - fall);
    }
  }
}
