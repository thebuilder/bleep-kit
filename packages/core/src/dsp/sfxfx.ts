/* Sfx-only voice effects (section 3.6): 12 dB lowpass with resonance, 12 dB highpass, phaser comb, bitcrush. */

const PHASER_RING = 1024;

export interface SfxFx {
  crushCount: number;
  crushHold: number;
  hp1x: number;
  hp1y: number;
  hp2y: number;
  lp1: number;
  lp2: number;
  pos: number;
  ring: Float32Array;
}

export function newSfxFx(): SfxFx {
  return {
    crushCount: 0,
    crushHold: 0,
    hp1x: 0,
    hp1y: 0,
    hp2y: 0,
    lp1: 0,
    lp2: 0,
    pos: 0,
    ring: new Float32Array(PHASER_RING),
  };
}

export function resetSfxFx(f: SfxFx): void {
  f.lp1 = 0;
  f.lp2 = 0;
  f.hp1x = 0;
  f.hp1y = 0;
  f.hp2y = 0;
  f.ring.fill(0);
  f.pos = 0;
  f.crushCount = 0;
  f.crushHold = 0;
}

/** One-pole coefficient for a cutoff in Hz. */
export function onePoleCoef(hz: number, sampleRate: number): number {
  const w = Math.min(hz, sampleRate * 0.45) / sampleRate;
  return 1 - Math.exp(-2 * Math.PI * w);
}

/** Two cascaded one-poles with resonance fed back from the second stage. */
export function runLowpass(
  f: SfxFx,
  buf: Float32Array,
  n: number,
  a: number,
  res: number
): void {
  let y1 = f.lp1;
  let y2 = f.lp2;
  const k = res * 3.2;
  for (let i = 0; i < n; i += 1) {
    let fb = y2 * k;
    fb = fb > 2 ? 2 : fb < -2 ? -2 : fb;
    const x = (buf[i] ?? 0) - fb;
    y1 += a * (x - y1);
    y2 += a * (y1 - y2);
    buf[i] = y2 * (1 + k * 0.5);
  }
  f.lp1 = y1;
  f.lp2 = y2;
}

/** Two cascaded one-pole highpasses. */
export function runHighpass(
  f: SfxFx,
  buf: Float32Array,
  n: number,
  a: number
): void {
  const r = 1 - a;
  let x1 = f.hp1x;
  let y1 = f.hp1y;
  let y2 = f.hp2y;
  for (let i = 0; i < n; i += 1) {
    const x = buf[i] ?? 0;
    const s1 = r * (y1 + x - x1);
    x1 = x;
    const s2 = r * (y2 + s1 - y1);
    y1 = s1;
    y2 = s2;
    buf[i] = s2;
  }
  f.hp1x = x1;
  f.hp1y = y1;
  f.hp2y = y2;
}

/** sfxr style phaser: a delayed copy mixed with the signal. delay is in samples (fractional), sign flips the copy. */
export function runPhaser(
  f: SfxFx,
  buf: Float32Array,
  n: number,
  delay: number,
  sign: number
): void {
  const ring = f.ring;
  let pos = f.pos;
  const d = Math.min(PHASER_RING - 2, Math.max(0, delay));
  const di = Math.floor(d);
  const frac = d - di;
  for (let i = 0; i < n; i += 1) {
    const x = buf[i] ?? 0;
    ring[pos] = x;
    const a = ring[(pos - di + PHASER_RING) & (PHASER_RING - 1)] ?? 0;
    const b = ring[(pos - di - 1 + PHASER_RING) & (PHASER_RING - 1)] ?? 0;
    const delayed = a + (b - a) * frac;
    buf[i] = 0.5 * (x + sign * delayed);
    pos = (pos + 1) & (PHASER_RING - 1);
  }
  f.pos = pos;
}

/** Quantize to `bits` and sample-and-hold every `divide` frames. bits 0 disables the quantizer. */
export function runBitcrush(
  f: SfxFx,
  buf: Float32Array,
  n: number,
  bits: number,
  divide: number
): void {
  const levels = bits > 0 ? 2 ** (bits - 1) : 0;
  let count = f.crushCount;
  let hold = f.crushHold;
  for (let i = 0; i < n; i += 1) {
    if (count <= 0) {
      let x = buf[i] ?? 0;
      if (levels > 0) {
        x = Math.round(x * levels) / levels;
      }
      hold = x;
      count = divide;
    }
    count -= 1;
    buf[i] = hold;
  }
  f.crushCount = count;
  f.crushHold = hold;
}
