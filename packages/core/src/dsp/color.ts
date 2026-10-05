/* Chip output coloring (section 3.8). Each chip owns a bus: the synth sums its voices into it, then the bus applies the
   DAC curve, sample rate reduction, bit depth and the one-pole filters. NES voices feed two mixer groups (pulse and
   triangle/noise) because the real APU mixes them non-linearly. */

import { CHIPS } from "../chips/index.ts";
import type { ChipId, ChipProfile } from "../types.ts";

const BLOCK = 128;

/** Linear gain applied after the NES mixer formula: the APU's output is tiny (about 0.26 for two full pulses). */
const NES_MIXER_SCALE = 4;
const SID_ASYMMETRY = 0.03;

/** Linear gain of each chip's voice sum, so a typical single voice peaks around -12 dBFS before the master gain. */
const CHIP_GAIN: Readonly<Record<ChipId, number>> = {
  adlib: 0.34,
  c64: 0.5,
  custom: 0.45,
  gameboy: 0.42,
  genesis: 0.4,
  nes: 1,
  snes: 0.65,
};
/** A bus keeps running this long after its last voice so filters and holds settle, then it is reset and skipped. */
const TAIL_SECONDS = 0.25;

/** The standard NES APU mixer, from the nesdev wiki: pulse and tnd groups mix separately and add. */
function nesMix(pulse: number, tri: number, noise: number): number {
  const p = pulse > 0 ? 95.88 / (8128 / pulse + 100) : 0;
  const tnd = tri / 8227 + noise / 12_241;
  const t = tnd > 0 ? 159.79 / (1 / tnd + 100) : 0;
  return p + t;
}

interface ChanState {
  g0: number;
  g1: number;
  g2: number;
  g3: number;
  hold: number;
  holdPhase: number;
  hpx: number;
  hpy: number;
  lpy: number;
}

function newChan(): ChanState {
  return {
    g0: 0,
    g1: 0,
    g2: 0,
    g3: 0,
    hold: 0,
    holdPhase: 0,
    hpx: 0,
    hpy: 0,
    lpy: 0,
  };
}

function resetChan(c: ChanState): void {
  c.hold = 0;
  c.holdPhase = 0;
  c.g0 = 0;
  c.g1 = 0;
  c.g2 = 0;
  c.g3 = 0;
  c.hpx = 0;
  c.hpy = 0;
  c.lpy = 0;
}

/** 4-tap gaussian kernel weights for a fractional position, as the SNES interpolator does (a soft, dull blur). */
const GAUSS_SIGMA = 0.62;
function gaussWeights(frac: number, w: Float64Array): void {
  let sum = 0;
  for (let k = 0; k < 4; k += 1) {
    const d = k - 1 - frac;
    const v = Math.exp(-(d * d) / (2 * GAUSS_SIGMA * GAUSS_SIGMA));
    w[k] = v;
    sum += v;
  }
  for (let k = 0; k < 4; k += 1) {
    w[k] = (w[k] ?? 0) / sum;
  }
}

const GAUSS_STEPS = 64;

export class ChipBus {
  readonly chip: ChipId;
  readonly profile: ChipProfile;
  readonly l = new Float32Array(BLOCK);
  readonly r = new Float32Array(BLOCK);
  /** NES mixer inputs: unipolar levels summed in 0..15 units per voice. */
  readonly pulse = new Float32Array(BLOCK);
  readonly tri = new Float32Array(BLOCK);
  readonly noise = new Float32Array(BLOCK);
  /** Mean level of each NES group (what a DC blocker would settle on), so level changes do not thump. */
  readonly pulseMid = new Float32Array(BLOCK);
  readonly triMid = new Float32Array(BLOCK);
  readonly noiseMid = new Float32Array(BLOCK);
  readonly outL = new Float32Array(BLOCK);
  readonly outR = new Float32Array(BLOCK);
  /** True once any voice wrote into the arrays this block. */
  touched = false;
  /** Frames since a voice last fed this bus. */
  idle = 0;
  running = false;

  private readonly cl = newChan();
  private readonly cr = newChan();
  private readonly dac: number;
  private readonly gain: number;
  private readonly holdStep: number;
  private readonly gaussian: boolean;
  private readonly bits: number;
  private readonly lpA: number;
  private readonly hpA: number;
  private readonly tailFrames: number;
  private readonly gwTable: Float64Array;

  constructor(chip: ChipId, sampleRate: number) {
    this.chip = chip;
    this.profile = CHIPS[chip];
    this.gain = CHIP_GAIN[chip];
    const c = this.profile.color;
    this.dac =
      c.dac === "nes" ? 1 : c.dac === "sid" ? 2 : c.dac === "ym" ? 3 : 0;
    const rate = c.sampleRate;
    this.holdStep = rate !== null && rate < sampleRate ? rate / sampleRate : 0;
    this.gaussian = c.gaussian && this.holdStep > 0;
    this.bits = c.bits !== null && c.bits < 24 ? c.bits : 0;
    this.lpA =
      c.lowpassHz !== null && c.lowpassHz < sampleRate * 0.45
        ? 1 - Math.exp((-2 * Math.PI * c.lowpassHz) / sampleRate)
        : 0;
    this.hpA =
      c.highpassHz === null
        ? 0
        : Math.exp((-2 * Math.PI * c.highpassHz) / sampleRate);
    this.tailFrames = Math.round(TAIL_SECONDS * sampleRate);
    this.gwTable = new Float64Array(GAUSS_STEPS * 4);
    const tmp = new Float64Array(4);
    for (let s = 0; s < GAUSS_STEPS; s += 1) {
      gaussWeights(s / GAUSS_STEPS, tmp);
      for (let k = 0; k < 4; k += 1) {
        this.gwTable[s * 4 + k] = tmp[k] ?? 0;
      }
    }
  }

  /** Zero the input arrays the first time a voice feeds the bus in a block. */
  touch(n: number): void {
    if (!this.touched) {
      this.touched = true;
      this.l.fill(0, 0, n);
      this.r.fill(0, 0, n);
      if (this.dac === 1) {
        this.pulse.fill(0, 0, n);
        this.tri.fill(0, 0, n);
        this.noise.fill(0, 0, n);
        this.pulseMid.fill(0, 0, n);
        this.triMid.fill(0, 0, n);
        this.noiseMid.fill(0, 0, n);
      }
    }
  }

  /** Whether process() has work for a block of n frames. */
  needsRun(): boolean {
    return this.touched || this.running;
  }

  private colorChannel(st: ChanState, buf: Float32Array, n: number): void {
    const dac = this.dac;
    const step = this.holdStep;
    const bits = this.bits;
    const levels = bits > 0 ? 2 ** (bits - 1) : 0;
    const lpA = this.lpA;
    const hpA = this.hpA;
    for (let i = 0; i < n; i += 1) {
      let x = buf[i] ?? 0;
      if (dac === 2) {
        x += SID_ASYMMETRY * x * x;
      } else if (dac === 3) {
        // 9-bit ladder: 256 steps per polarity
        x = x > 1 ? 1 : x < -1 ? -1 : x;
        x = Math.round(x * 255) / 255;
      }
      if (step > 0) {
        if (this.gaussian) {
          st.holdPhase += step;
          if (st.holdPhase >= 1) {
            st.holdPhase -= 1;
            st.g0 = st.g1;
            st.g1 = st.g2;
            st.g2 = st.g3;
            st.g3 = x;
          }
          const idx =
            Math.min(GAUSS_STEPS - 1, Math.floor(st.holdPhase * GAUSS_STEPS)) *
            4;
          const t = this.gwTable;
          x =
            st.g0 * (t[idx] ?? 0) +
            st.g1 * (t[idx + 1] ?? 0) +
            st.g2 * (t[idx + 2] ?? 0) +
            st.g3 * (t[idx + 3] ?? 0);
        } else {
          st.holdPhase += step;
          if (st.holdPhase >= 1) {
            st.holdPhase -= 1;
            st.hold = x;
          }
          x = st.hold;
        }
      }
      if (levels > 0) {
        x = Math.round(x * levels) / levels;
      }
      if (lpA > 0) {
        st.lpy += lpA * (x - st.lpy);
        if (st.lpy < 1e-9 && st.lpy > -1e-9) {
          st.lpy = 0;
        }
        x = st.lpy;
      }
      if (hpA > 0) {
        const y = hpA * (st.hpy + x - st.hpx);
        st.hpx = x;
        st.hpy = y < 1e-9 && y > -1e-9 ? 0 : y;
        x = st.hpy;
      }
      buf[i] = x;
    }
  }

  /** Color the n frames fed this block into outL and outR. */
  process(n: number): void {
    const oL = this.outL;
    const oR = this.outR;
    if (this.touched) {
      this.idle = 0;
      this.running = true;
      if (this.dac === 1) {
        const p = this.pulse;
        const t = this.tri;
        const z = this.noise;
        const pm = this.pulseMid;
        const tm = this.triMid;
        const zm = this.noiseMid;
        for (let i = 0; i < n; i += 1) {
          const v =
            (nesMix(p[i] ?? 0, t[i] ?? 0, z[i] ?? 0) -
              nesMix(pm[i] ?? 0, tm[i] ?? 0, zm[i] ?? 0)) *
            NES_MIXER_SCALE;
          oL[i] = v + (this.l[i] ?? 0);
          oR[i] = v + (this.r[i] ?? 0);
        }
      } else {
        const g = this.gain;
        for (let i = 0; i < n; i += 1) {
          oL[i] = (this.l[i] ?? 0) * g;
          oR[i] = (this.r[i] ?? 0) * g;
        }
      }
    } else {
      oL.fill(0, 0, n);
      oR.fill(0, 0, n);
      this.idle += n;
      if (this.idle > this.tailFrames) {
        this.running = false;
        resetChan(this.cl);
        resetChan(this.cr);
        return;
      }
    }
    this.colorChannel(this.cl, oL, n);
    this.colorChannel(this.cr, oR, n);
    this.touched = false;
  }
}
