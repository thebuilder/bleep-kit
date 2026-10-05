/* Lookahead peak limiter (section 3.8): ceiling -0.3 dBFS, about 1 ms lookahead, 50 ms release. The gain at each
   output sample is the box average (over the lookahead) of a release-smoothed running minimum, delayed so the
   average never exceeds the gain a peak needs. Always the last stage, in realtime and offline alike. */

const LIMITER_CEILING_DB = -0.3;
export const LIMITER_CEILING = 10 ** (LIMITER_CEILING_DB / 20);
const RELEASE_SECONDS = 0.05;
const MAX_LOOKAHEAD = 64;

export class Limiter {
  /** Frames of delay the limiter adds to the signal. */
  readonly latency: number;
  enabled = true;
  private readonly look: number;
  private readonly xl = new Float32Array(MAX_LOOKAHEAD);
  private readonly xr = new Float32Array(MAX_LOOKAHEAD);
  private readonly gin = new Float32Array(MAX_LOOKAHEAD).fill(1);
  private readonly renv = new Float32Array(MAX_LOOKAHEAD).fill(1);
  private pos = 0;
  private env = 1;
  private sum: number;
  private readonly relCoef: number;
  /** Lowest gain applied since reset, for tests. */
  minGain = 1;

  constructor(sampleRate: number) {
    this.look = Math.min(
      MAX_LOOKAHEAD,
      Math.max(8, Math.round(0.001 * sampleRate))
    );
    this.latency = this.look - 1;
    this.relCoef = Math.exp(-1 / (RELEASE_SECONDS * sampleRate));
    this.sum = this.look;
  }

  /** In place on n frames of stereo. */
  process(left: Float32Array, right: Float32Array, n: number): void {
    const look = this.look;
    const ring = MAX_LOOKAHEAD;
    const mask = ring - 1;
    const enabled = this.enabled;
    const xl = this.xl;
    const xr = this.xr;
    const gin = this.gin;
    const renv = this.renv;
    let pos = this.pos;
    let env = this.env;
    let sum = this.sum;
    const rel = this.relCoef;
    let minGain = this.minGain;
    for (let i = 0; i < n; i += 1) {
      const l = left[i] ?? 0;
      const r = right[i] ?? 0;
      const a = l < 0 ? -l : l;
      const b = r < 0 ? -r : r;
      const peak = a > b ? a : b;
      const g = peak > LIMITER_CEILING ? LIMITER_CEILING / peak : 1;
      xl[pos] = l;
      xr[pos] = r;
      gin[pos] = g;
      // minimum over the last `look` input gains
      let gmin = 1;
      for (let k = 0; k < look; k += 1) {
        const v = gin[(pos - k) & mask] ?? 1;
        if (v < gmin) {
          gmin = v;
        }
      }
      // instant attack, exponential release
      env = gmin < env ? gmin : gmin + (env - gmin) * rel;
      // box average of the smoothed gain over `look` samples
      const old = renv[(pos - look) & mask] ?? 1;
      renv[pos] = env;
      sum += env - old;
      const gs = enabled ? sum / look : 1;
      const d = (pos - (look - 1)) & mask;
      left[i] = (xl[d] ?? 0) * gs;
      right[i] = (xr[d] ?? 0) * gs;
      if (gs < minGain) {
        minGain = gs;
      }
      pos = (pos + 1) & mask;
    }
    this.pos = pos;
    this.env = env;
    this.sum = sum;
    this.minGain = minGain;
  }
}
