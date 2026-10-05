// biome-ignore-all lint/style/noNestedTernary: clamps and branch selects in the audio path read best inline
// biome-ignore-all lint/style/useDestructuring: per-sample loops copy fields into locals on purpose, destructuring adds nothing there
/* Chamberlin state variable filter, run at twice the host rate so it stays stable up to 12 kHz cutoffs. */

export const SVF_LP = 1;
export const SVF_BP = 2;
export const SVF_HP = 3;

export interface Svf {
  band: number;
  f: number;
  low: number;
  mode: number;
  q: number;
}

export function newSvf(): Svf {
  return { band: 0, f: 0.1, low: 0, mode: SVF_LP, q: 1 };
}

export function svfReset(s: Svf): void {
  s.low = 0;
  s.band = 0;
}

/** cutoff in Hz, Q 0.5 and up. */
export function svfSet(
  s: Svf,
  cutoffHz: number,
  qFactor: number,
  mode: number,
  sampleRate: number
): void {
  const fs2 = sampleRate * 2;
  const hz = Math.min(cutoffHz, sampleRate * 0.45);
  s.f = 2 * Math.sin((Math.PI * hz) / fs2);
  s.q = 1 / Math.max(0.5, qFactor);
  s.mode = mode;
}

export function svfProcess(s: Svf, buf: Float32Array, n: number): void {
  let low = s.low;
  let band = s.band;
  const f = s.f;
  const q = s.q;
  const mode = s.mode;
  for (let i = 0; i < n; i += 1) {
    const x = buf[i] ?? 0;
    let high = 0;
    for (let k = 0; k < 2; k += 1) {
      high = x - low - q * band;
      band += f * high;
      low += f * band;
      // keep the loop bounded if something overdrives it
      if (band > 8) {
        band = 8;
      } else if (band < -8) {
        band = -8;
      }
    }
    buf[i] = mode === SVF_LP ? low : mode === SVF_BP ? band * q : high;
  }
  s.low = low;
  s.band = band;
}
