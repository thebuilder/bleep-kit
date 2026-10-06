/* A steady oscilloscope trigger. The period of the wave comes from the channel's note frequency (the engine's noteOn
   event, the most reliable source) refined by autocorrelation, or from autocorrelation alone. The trigger is a rising
   crossing of the wave's own mid level with hysteresis, picked so that its phase continues from the last frame (the lock
   is kept in absolute engine frames), and the trace shows a whole number of periods, so a held note stands still. */

export interface Trigger {
  /** Absolute engine frame (fractional) of the crossing the last frame locked to; negative before the first lock. */
  at: number;
  /** Frames to wait before the next full period search, after one that found nothing. */
  idle: number;
  /** Period in frames the last frame found; 0 when the wave has none (noise, silence). */
  period: number;
}

export interface TriggerOpts {
  /** The channel's note frequency in Hz, when the engine told us. */
  hintHz?: number;
  sampleRate: number;
  /** About how many frames to show; the real span is a whole number of periods near this. */
  targetSpan: number;
}

export interface TriggerResult {
  /** Estimated period in frames, 0 when none. */
  period: number;
  /** Frames the trace covers (a whole number of periods when there is a period). */
  span: number;
  /** Index into the buffer (fractional) where the trace starts. */
  start: number;
}

/** Most periods drawn at once: a high note stays readable at the 96 pixel scope width. */
const MAX_PERIODS = 6;
const MIN_LAG = 6;
/** Normalized correlation above which a period is believed. */
const GOOD_CORR = 0.8;
const HYSTERESIS = 0.12;
/** Largest phase distance (as a fraction of the period) at which the lock is kept. */
const LOCK_TOLERANCE = 0.2;
/** Frames without a full period search after one that found no period. */
const IDLE_FRAMES = 8;

export function createTrigger(): Trigger {
  return { at: -1, idle: 0, period: 0 };
}

/** A signal with its mean removed, and the running sum of its squares, so a lag's correlation is one multiply loop. */
interface Prep {
  /** pre[i] is the energy of the first i samples. */
  pre: Float64Array;
  x: Float32Array;
}

function newPrep(n: number): Prep {
  return { pre: new Float64Array(n + 1), x: new Float32Array(n) };
}

/** Fill `into` from `src`, averaged down by `down`, with the mean taken out. */
function prepare(src: Float32Array, down: number, into: Prep): number {
  const n = Math.floor(src.length / down);
  let mean = 0;
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let k = 0; k < down; k += 1) {
      sum += src[i * down + k] ?? 0;
    }
    const v = sum / down;
    into.x[i] = v;
    mean += v;
  }
  mean /= Math.max(1, n);
  let energy = 0;
  into.pre[0] = 0;
  for (let i = 0; i < n; i += 1) {
    const v = (into.x[i] ?? 0) - mean;
    into.x[i] = v;
    energy += v * v;
    into.pre[i + 1] = energy;
  }
  return n;
}

/** Normalized correlation of the first `n` samples of `p` with themselves `lag` samples later. */
function corr(p: Prep, n: number, lag: number): number {
  const len = n - lag;
  if (len < 8 || lag < 1) {
    return 0;
  }
  let ab = 0;
  for (let i = 0; i < len; i += 1) {
    ab += (p.x[i] as number) * (p.x[i + lag] as number);
  }
  const d = Math.sqrt(
    (p.pre[len] as number) * ((p.pre[n] as number) - (p.pre[lag] as number))
  );
  return d > 1e-12 ? ab / d : 0;
}

let fullPrep = newPrep(0);
let coarsePrep = newPrep(0);
const COARSE = 4;

/** Prepare both scratch signals for `x` (reused between calls: the realtime visuals do not allocate each frame). */
function prepareBoth(x: Float32Array): { coarse: number; full: number } {
  if (fullPrep.x.length < x.length) {
    fullPrep = newPrep(x.length);
    coarsePrep = newPrep(Math.ceil(x.length / COARSE));
  }
  return {
    coarse: prepare(x, COARSE, coarsePrep),
    full: prepare(x, 1, fullPrep),
  };
}

/** The best lag within `around` of `lag` in the prepared full signal, refined by a parabola through the peak. */
function refinePrepared(
  n: number,
  lag: number,
  around: number
): { corr: number; lag: number } {
  const c0 = Math.max(MIN_LAG, Math.round(lag));
  const lo = Math.max(MIN_LAG, c0 - around);
  const vals: number[] = [];
  let bi = 0;
  for (let l = lo; l <= c0 + around; l += 1) {
    vals.push(corr(fullPrep, n, l));
    if ((vals.at(-1) as number) > (vals[bi] as number)) {
      bi = vals.length - 1;
    }
  }
  const a = vals[bi - 1];
  const b = vals[bi] as number;
  const c = vals[bi + 1];
  let frac = 0;
  if (a !== undefined && c !== undefined) {
    const den = a - 2 * b + c;
    if (den < -1e-9) {
      frac = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
    }
  }
  return { corr: b, lag: lo + bi + frac };
}

/** The best lag within `around` frames either side of `lag`, refined to a fraction by a parabola through the peak. */
export function refineLag(
  x: Float32Array,
  lag: number,
  around = 2
): { corr: number; lag: number } {
  const { full } = prepareBoth(x);
  return refinePrepared(full, lag, around);
}

function searchPrepared(n: number, m: number): { corr: number; lag: number } {
  const maxLag = Math.floor(m / 2);
  const minLag = Math.max(2, Math.ceil(MIN_LAG / COARSE));
  const cs = new Float32Array(maxLag + 2);
  for (let l = minLag; l <= maxLag; l += 1) {
    cs[l] = corr(coarsePrep, m, l);
  }
  // the correlation is high at tiny lags whatever the wave: start after it first falls away
  let from = minLag;
  while (from <= maxLag && (cs[from] ?? 0) > 0.2) {
    from += 1;
  }
  let top = 0;
  for (let l = from; l <= maxLag; l += 1) {
    top = Math.max(top, cs[l] ?? 0);
  }
  if (top < 0.5) {
    return { corr: top, lag: 0 };
  }
  // the first strong local peak, not the strongest: a multiple of the period correlates just as well
  for (let l = from; l <= maxLag; l += 1) {
    const c = cs[l] ?? 0;
    if (c >= top * 0.8 && c >= (cs[l - 1] ?? 0) && c >= (cs[l + 1] ?? 0)) {
      return refinePrepared(n, l * COARSE, COARSE);
    }
  }
  return { corr: 0, lag: 0 };
}

/** The period with no hint: a coarse search on the signal averaged down by 4, then a refinement at full rate. */
export function searchPeriod(x: Float32Array): { corr: number; lag: number } {
  const { coarse, full } = prepareBoth(x);
  return searchPrepared(full, coarse);
}

/** Rising crossings of `mid` (fractional indices), each armed only after the wave fell `hyst` below `mid`. */
export function risingCrossings(
  x: Float32Array,
  mid: number,
  hyst: number
): number[] {
  const out: number[] = [];
  let armed = false;
  for (let i = 1; i < x.length; i += 1) {
    const v = (x[i] ?? 0) - mid;
    if (v < -hyst) {
      armed = true;
    } else if (armed && v >= 0) {
      const p = (x[i - 1] ?? 0) - mid;
      out.push(i - 1 + (v === p ? 1 : -p / (v - p)));
      armed = false;
    }
  }
  return out;
}

/**
 * The crossing to start the trace on: one with room for `span` frames after it, and with the phase of `lockAt` (an
 * index in this buffer, any whole number of periods away) when that is near enough, else the steepest one. The latest
 * such crossing wins, so the trace shows the freshest sound. Returns -1 when there is none.
 */
export function findTrigger(
  x: Float32Array,
  period: number,
  span: number,
  lockAt?: number
): number {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of x) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const amp = (hi - lo) / 2;
  if (amp < 1e-4) {
    return -1;
  }
  const mid = (hi + lo) / 2;
  const all = risingCrossings(x, mid, amp * HYSTERESIS);
  const room = x.length - span;
  const valid = all.filter((c) => c <= room);
  if (valid.length === 0) {
    return all[0] ?? -1;
  }
  if (period > 0 && lockAt !== undefined) {
    const near = (c: number): number => {
      const d = (c - lockAt) / period;
      return Math.abs(d - Math.round(d));
    };
    const matched = valid.filter((c) => near(c) <= LOCK_TOLERANCE);
    if (matched.length > 0) {
      return matched.at(-1) as number;
    }
  }
  // no lock: the crossing with the steepest rise, so every period of a periodic wave picks the same kind of edge
  const look = Math.max(2, Math.round((period || 32) / 8));
  const rise = (c: number): number =>
    (x[Math.min(x.length - 1, Math.floor(c) + look)] ?? 0) - mid;
  let top = Number.NEGATIVE_INFINITY;
  for (const c of valid) {
    top = Math.max(top, rise(c));
  }
  const ties = valid.filter((c) => rise(c) >= top * 0.97 - 1e-6);
  return (ties.at(-1) ?? valid.at(-1)) as number;
}

/** The period of `x`: the hint if the wave really repeats at it, else the previous one, else a fresh search. */
function estimatePeriod(x: Float32Array, t: Trigger, o: TriggerOpts): number {
  const sizes = prepareBoth(x);
  const hint = o.hintHz && o.hintHz > 20 ? o.sampleRate / o.hintHz : 0;
  for (const s of [hint, t.period]) {
    if (s > MIN_LAG && s * 2 < x.length) {
      const r = refinePrepared(sizes.full, s, 2);
      if (r.corr >= GOOD_CORR) {
        if (
          s === hint &&
          Math.abs(r.lag - hint) <= Math.max(0.6, hint * 0.01)
        ) {
          // the engine's own note frequency is exact: the correlation only confirms it
          return hint;
        }
        // a steady estimate: small changes are smoothed away, so the span does not breathe
        return t.period > 0 && Math.abs(r.lag - t.period) < t.period * 0.01
          ? t.period * 0.8 + r.lag * 0.2
          : r.lag;
      }
    }
  }
  if (t.idle > 0) {
    // the last full search found nothing (noise, a chord): do not repeat it every frame
    t.idle -= 1;
    return 0;
  }
  const found = searchPrepared(sizes.full, sizes.coarse);
  const ok = found.corr >= GOOD_CORR * 0.75;
  t.idle = ok ? 0 : IDLE_FRAMES;
  return ok ? found.lag : 0;
}

/**
 * Pick the window of `x` (the samples from absolute frame `base`) to draw, and keep the lock for the next frame.
 * `x` should be at least a few periods long.
 */
export function locate(
  t: Trigger,
  x: Float32Array,
  base: number,
  o: TriggerOpts
): TriggerResult {
  const n = x.length;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of x) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (!((hi - lo) / 2 >= 1e-4)) {
    // silence: nothing to lock to, and nothing worth correlating
    t.period = 0;
    return { period: 0, span: Math.min(o.targetSpan, n), start: 0 };
  }
  const period = estimatePeriod(x, t, o);
  let periods = 0;
  let span = Math.min(o.targetSpan, n);
  if (period > 0) {
    const fit = Math.floor((n - period) / period);
    periods = Math.max(
      1,
      Math.min(MAX_PERIODS, fit, Math.round(o.targetSpan / period))
    );
    span = Math.min(n, periods * period);
  }
  const lockAt = t.at >= 0 ? t.at - base : undefined;
  const c = findTrigger(x, period, span, lockAt);
  if (c < 0) {
    t.period = period;
    return { period, span, start: 0 };
  }
  t.at = base + c;
  t.period = period;
  return { period, span: Math.min(span, n - c), start: c };
}

/** `data` at a fractional index, linearly interpolated (zero outside). */
export function sampleAt(data: Float32Array, pos: number): number {
  const i = Math.floor(pos);
  const f = pos - i;
  const a = data[i] ?? 0;
  const b = data[i + 1] ?? a;
  return a + (b - a) * f;
}

/**
 * Like scopeTrace in canvas.ts, for a fractional `start` and `span`: each of the `w` columns reads the wave at
 * start + span * x / w, interpolated, so a locked trace does not shimmer from rounding. Full scale lands 2 px from the
 * top and bottom edge and each column reaches back to the row the previous one ended on.
 */
export function scopeTraceAt(
  data: Float32Array,
  start: number,
  span: number,
  w: number,
  h: number
): { peak: number; spans: Int32Array } {
  const mid = h / 2;
  const spans = new Int32Array(w * 2);
  let prevY = mid;
  let peak = 0;
  for (let x = 0; x < w; x += 1) {
    const v = Math.min(1, Math.max(-1, sampleAt(data, start + (span * x) / w)));
    peak = Math.max(peak, Math.abs(v));
    const y = Math.round(mid - v * (mid - 2));
    spans[x * 2] = Math.min(y, prevY);
    spans[x * 2 + 1] = Math.max(y, prevY);
    prevY = y;
  }
  return { peak, spans };
}
