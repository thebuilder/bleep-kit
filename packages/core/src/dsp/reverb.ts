/* Master reverb (section 3.6): a small Schroeder network, 4 parallel feedback combs (damped by a one-pole in each)
   into 2 series allpasses per side. Delay lengths follow Freeverb and scale with `size`. Fed by the reverb sends. */

const COMBS = [1116, 1188, 1277, 1356] as const;
const ALLPASS = [556, 441] as const;
const SPREAD = 23;
/** Longest scale of the base lengths, so the buffers can be allocated once. */
const MAX_SCALE = 1.6;
const MIN_SCALE = 0.45;

class Comb {
  buf: Float32Array;
  len = 1;
  pos = 0;
  store = 0;

  constructor(max: number) {
    this.buf = new Float32Array(max);
  }
}

class Allpass {
  buf: Float32Array;
  len = 1;
  pos = 0;

  constructor(max: number) {
    this.buf = new Float32Array(max);
  }
}

export class Reverb {
  enabled = false;
  private readonly combsL: Comb[] = [];
  private readonly combsR: Comb[] = [];
  private readonly apL: Allpass[] = [];
  private readonly apR: Allpass[] = [];
  private feedback = 0.8;
  private damp = 0.3;
  private level = 0;
  private readonly rateScale: number;

  constructor(sampleRate: number) {
    this.rateScale = sampleRate / 44_100;
    for (const c of COMBS) {
      const max = Math.ceil((c + SPREAD) * this.rateScale * MAX_SCALE) + 2;
      this.combsL.push(new Comb(max));
      this.combsR.push(new Comb(max));
    }
    for (const a of ALLPASS) {
      const max = Math.ceil((a + SPREAD) * this.rateScale * MAX_SCALE) + 2;
      this.apL.push(new Allpass(max));
      this.apR.push(new Allpass(max));
    }
  }

  configure(size: number, damping: number, level: number): void {
    const s = Math.min(1, Math.max(0, size));
    const scale = MIN_SCALE + (MAX_SCALE - MIN_SCALE) * s;
    for (let i = 0; i < COMBS.length; i += 1) {
      const base = COMBS[i] ?? 1000;
      const l = this.combsL[i];
      const r = this.combsR[i];
      if (l) {
        l.len = Math.max(2, Math.round(base * this.rateScale * scale));
      }
      if (r) {
        r.len = Math.max(
          2,
          Math.round((base + SPREAD) * this.rateScale * scale)
        );
      }
    }
    for (let i = 0; i < ALLPASS.length; i += 1) {
      const base = ALLPASS[i] ?? 400;
      const l = this.apL[i];
      const r = this.apR[i];
      if (l) {
        l.len = Math.max(
          2,
          Math.round(base * this.rateScale * Math.max(0.6, scale))
        );
      }
      if (r) {
        r.len = Math.max(
          2,
          Math.round((base + SPREAD) * this.rateScale * Math.max(0.6, scale))
        );
      }
    }
    this.feedback = 0.7 + 0.26 * s;
    this.damp = Math.min(0.95, Math.max(0, damping)) * 0.8;
    this.level = level;
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  reset(): void {
    for (const c of [...this.combsL, ...this.combsR]) {
      c.buf.fill(0);
      c.pos = 0;
      c.store = 0;
    }
    for (const a of [...this.apL, ...this.apR]) {
      a.buf.fill(0);
      a.pos = 0;
    }
  }

  private side(
    combs: Comb[],
    aps: Allpass[],
    inp: Float32Array,
    out: Float32Array,
    n: number
  ): void {
    const fb = this.feedback;
    const damp = this.damp;
    const level = this.level;
    for (let i = 0; i < n; i += 1) {
      const x = (inp[i] ?? 0) * 0.25;
      let sum = 0;
      for (let c = 0; c < combs.length; c += 1) {
        const cb = combs[c];
        if (!cb) {
          continue;
        }
        const y = cb.buf[cb.pos] ?? 0;
        cb.store = y * (1 - damp) + cb.store * damp;
        cb.buf[cb.pos] = x + cb.store * fb;
        cb.pos += 1;
        if (cb.pos >= cb.len) {
          cb.pos = 0;
        }
        sum += y;
      }
      for (let a = 0; a < aps.length; a += 1) {
        const ap = aps[a];
        if (!ap) {
          continue;
        }
        const bufout = ap.buf[ap.pos] ?? 0;
        const v = sum;
        sum = bufout - v;
        ap.buf[ap.pos] = v + bufout * 0.5;
        ap.pos += 1;
        if (ap.pos >= ap.len) {
          ap.pos = 0;
        }
      }
      out[i] = (out[i] ?? 0) + sum * level;
    }
  }

  /** Adds the wet signal into outL and outR. */
  process(
    inL: Float32Array,
    inR: Float32Array,
    outL: Float32Array,
    outR: Float32Array,
    n: number
  ): void {
    this.side(this.combsL, this.apL, inL, outL, n);
    this.side(this.combsR, this.apR, inR, outR, n);
  }
}
