// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: audio hot paths and long effect switches stay in one function: no call overhead and the order reads like the signal flow
// biome-ignore-all lint/style/noNestedTernary: clamps and branch selects in the audio path read best inline
// biome-ignore-all lint/style/useDestructuring: per-sample loops copy fields into locals on purpose, destructuring adds nothing there
// biome-ignore-all lint/suspicious/noBitwiseOperators: DSP code: LFSR shifts, power-of-two ring masks, integer hashing and flag masks need bit operations
/* SID oscillators (section 3.3): 24-bit phase accumulators, tri, saw, pulse and 23-bit LFSR noise, waveform combining
   by AND of the 12-bit outputs, ring modulation and hard sync between neighbouring voices. */

import { polyBlep } from "./osc.ts";

export const SID_TRI = 1;
export const SID_SAW = 2;
export const SID_PULSE = 4;
export const SID_NOISE = 8;

const ACC = 16_777_216;
const MSB = 8_388_608;
const BIT19 = 524_288;

export interface SidOsc {
  acc: number;
  active: boolean;
  dt: number;
  lfsr: number;
  mask: number;
  noiseByte: number;
  pw12: number;
  ring: boolean;
  /** Frequency register (accumulator increment per SID clock, scaled to one host sample by `step`). */
  step: number;
  sync: boolean;
}

export function newSidOsc(): SidOsc {
  return {
    acc: 0,
    active: false,
    dt: 0,
    lfsr: 0x7f_ff_f8,
    mask: SID_PULSE,
    noiseByte: 0,
    pw12: 2048,
    ring: false,
    step: 0,
    sync: false,
  };
}

export function seedSid(o: SidOsc, seed: number): void {
  o.lfsr = ((Math.abs(seed | 0) % 0x7f_ff_ff) | 0x1) & 0x7f_ff_ff;
  if (o.lfsr === 0) {
    o.lfsr = 0x7f_ff_f8;
  }
}

function clockNoise(o: SidOsc): void {
  const l = o.lfsr;
  const bit = ((l >> 22) ^ (l >> 17)) & 1;
  o.lfsr = ((l << 1) | bit) & 0x7f_ff_ff;
  o.noiseByte =
    ((o.lfsr >> 22) & 1) * 128 +
    ((o.lfsr >> 20) & 1) * 64 +
    ((o.lfsr >> 16) & 1) * 32 +
    ((o.lfsr >> 13) & 1) * 16 +
    ((o.lfsr >> 11) & 1) * 8 +
    ((o.lfsr >> 7) & 1) * 4 +
    ((o.lfsr >> 4) & 1) * 2 +
    ((o.lfsr >> 2) & 1);
}

/** Set the accumulator step for one host sample: register F advances the accumulator F * (clock / host rate) per sample. */
export function sidSetRate(
  o: SidOsc,
  f: number,
  clock: number,
  sampleRate: number
): void {
  o.step = (f * clock) / sampleRate;
  o.dt = Math.min(0.45, o.step / ACC);
}

function wave12(o: SidOsc, ringMsb: number): number {
  const acc = o.acc;
  const m = o.mask;
  let v = 0xf_ff;
  let any = false;
  if (m & SID_TRI) {
    const msb = ((acc & MSB) === 0 ? 0 : 1) ^ ringMsb;
    let t = Math.floor(acc / 2048) & 0xf_ff;
    if (msb) {
      t = ~t & 0xf_ff;
    }
    v &= t;
    any = true;
  }
  if (m & SID_SAW) {
    v &= Math.floor(acc / 4096) & 0xf_ff;
    any = true;
  }
  if (m & SID_PULSE) {
    v &= (Math.floor(acc / 4096) & 0xf_ff) >= o.pw12 ? 0xf_ff : 0;
    any = true;
  }
  if (m & SID_NOISE) {
    v &= o.noiseByte * 16;
    any = true;
  }
  return any ? v / 2047.5 - 1 : 0;
}

/** Render up to three voices together so ring modulation and sync see each other sample by sample.
    Voice i is modulated by voice (i + 2) mod 3. Inactive voices are skipped (their output stays zero). */
const PREV = [0, 0, 0];
const RISE = [false, false, false];

export function renderSidGroup(
  osc: readonly SidOsc[],
  outs: readonly Float32Array[],
  n: number
): void {
  const count = osc.length;
  const prev = PREV;
  const rise = RISE;
  for (let k = 0; k < n; k += 1) {
    for (let i = 0; i < count; i += 1) {
      const o = osc[i];
      if (!o?.active) {
        rise[i] = false;
        continue;
      }
      const before = o.acc;
      prev[i] = before;
      let a = before + o.step;
      if (a >= ACC) {
        a -= ACC;
        if (a >= ACC) {
          a %= ACC;
        }
      }
      o.acc = a;
      rise[i] = before < MSB && a >= MSB;
      if ((before & BIT19) === 0 && (a & BIT19) !== 0) {
        clockNoise(o);
      } else if (a < before && (a & BIT19) !== 0) {
        clockNoise(o);
      }
    }
    for (let i = 0; i < count; i += 1) {
      const o = osc[i];
      if (!o?.active) {
        continue;
      }
      const m = (i + 2) % 3;
      const mod = osc[m];
      if (o.sync && mod?.active && rise[m]) {
        o.acc = 0;
      }
      const ringMsb = o.ring && mod ? ((mod.acc & MSB) === 0 ? 0 : 1) : 0;
      const out = outs[i];
      if (!out) {
        continue;
      }
      if (o.mask === SID_PULSE) {
        // a lone pulse is band-limited; combined waveforms stay raw on purpose
        const phase = o.acc / ACC;
        const d = Math.min(0.98, Math.max(0.02, o.pw12 / 4096));
        let v = phase < d ? 1 : -1;
        v += polyBlep(phase, o.dt);
        let t2 = phase + 1 - d;
        if (t2 >= 1) {
          t2 -= 1;
        }
        v -= polyBlep(t2, o.dt);
        out[k] = v;
      } else {
        out[k] = wave12(o, ringMsb);
      }
    }
  }
}
