/* LFSR noise generators for each chip (section 3.3). A generator is clocked at the chip's noise rate; when the rate
   exceeds the host rate the bits inside one output sample are averaged (a box filter), as an emulator would. */

export const NOISE_NES_LONG = 0;
export const NOISE_NES_SHORT = 1;
export const NOISE_GB_LONG = 2;
export const NOISE_GB_SHORT = 3;
export const NOISE_PSG_WHITE = 4;
export const NOISE_PSG_PERIODIC = 5;
export const NOISE_WHITE = 6;

export interface NoiseState {
  /** Fractional LFSR steps owed to the next output sample. */
  acc: number;
  last: number;
  lfsr: number;
  mode: number;
  /** LFSR steps per host sample. */
  stepsPerSample: number;
}

export function newNoise(): NoiseState {
  return { acc: 0, last: 1, lfsr: 1, mode: NOISE_NES_LONG, stepsPerSample: 0 };
}

/** Seed the register (never zero) and pick the model. */
export function seedNoise(s: NoiseState, mode: number, seed: number): void {
  s.mode = mode;
  s.lfsr = (Math.abs(seed | 0) % 32_767) + 1;
  s.acc = 0;
}

/** Advance one LFSR step and return the output bit as +1 or -1. */
export function stepNoise(s: NoiseState): number {
  const r = s.lfsr;
  let fb: number;
  switch (s.mode) {
    case NOISE_NES_SHORT:
      fb = (r ^ (r >> 6)) & 1;
      s.lfsr = (r >> 1) | (fb << 14);
      break;
    case NOISE_GB_SHORT:
      fb = (r ^ (r >> 1)) & 1;
      s.lfsr = ((r >> 1) & ~(1 << 6) & 0x7f_ff) | (fb << 14) | (fb << 6);
      break;
    case NOISE_PSG_PERIODIC:
      fb = r & 1;
      s.lfsr = (r >> 1) | (fb << 14);
      break;
    default:
      // NES long, GB long, PSG white and the free white noise: taps at bit 0 and bit 1 into bit 14
      fb = (r ^ (r >> 1)) & 1;
      s.lfsr = (r >> 1) | (fb << 14);
      break;
  }
  return r & 1 ? -1 : 1;
}

const MAX_STEPS = 32;

export function renderNoise(s: NoiseState, out: Float32Array, n: number): void {
  const rate = s.stepsPerSample;
  let acc = s.acc;
  let last = s.last;
  for (let i = 0; i < n; i += 1) {
    acc += rate;
    let steps = Math.floor(acc);
    acc -= steps;
    if (steps > 0) {
      if (steps > MAX_STEPS) {
        steps = MAX_STEPS;
      }
      let sum = 0;
      for (let k = 0; k < steps; k += 1) {
        sum += stepNoise(s);
      }
      if (steps === 1) {
        last = sum;
      } else {
        // average, then lift back toward unit variance (capped at 2) so bright noise is not much quieter than dull noise
        // but a hiss that averages many steps does not outshout a boom that averages few
        const v = (sum / steps) * Math.min(Math.sqrt(steps), 2);
        last = v > 1 ? 1 : v < -1 ? -1 : v;
      }
    }
    out[i] = last;
  }
  s.acc = acc;
  s.last = last;
}
