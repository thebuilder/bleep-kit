/* Deterministic math and noise. Everything a generator draws must come from these (or its own seeded rng), never Math.random, so a scene always renders the same pixels. */
export const TAU = Math.PI * 2;
export const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(
  (v) => (v + 0.5) / 16
);
/** Ordered-dither threshold for a pixel, 0..1. */
export const bay = (x: number, y: number): number =>
  BAYER[(y & 3) * 4 + (x & 3)] ?? 0;
/** Seeded PRNG. Returns a function producing floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a += 0x6d_2b_79_f5;
    a |= 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
/** Stateless integer hash to [0, 1]. */
export function hash2(x: number, y: number, s: number): number {
  let h =
    Math.imul(x | 0, 374_761_393) ^
    Math.imul(y | 0, 668_265_263) ^
    Math.imul(s | 0, 982_451_653);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_295;
}
/** 2D value noise in [0, 1]. */
export function vnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x),
    yi = Math.floor(y),
    xf = x - xi,
    yf = y - yi;
  const u = xf * xf * (3 - 2 * xf),
    v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s),
    b = hash2(xi + 1, yi, s),
    c = hash2(xi, yi + 1, s),
    d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** 1D fractal noise, 4 octaves, in [0, 1]. */
export function fbm(x: number, s: number): number {
  let v = 0,
    amp = 0.5,
    tot = 0,
    f = 1;
  for (let o = 0; o < 4; o++) {
    v += vnoise(x * f, o * 17.3, s + o) * amp;
    tot += amp;
    amp *= 0.5;
    f *= 2;
  }
  return v / tot;
}
/** 2D fractal noise in [0, 1]. */
export function fbm2(x: number, y: number, s: number, oct = 3): number {
  let v = 0,
    amp = 0.5,
    tot = 0,
    f = 1;
  for (let o = 0; o < oct; o++) {
    v += vnoise(x * f, y * f, s + o * 13) * amp;
    tot += amp;
    amp *= 0.5;
    f *= 2;
  }
  return v / tot;
}
export const mod = (a: number, n: number): number => ((a % n) + n) % n;
export const frac = (v: number): number => v - Math.floor(v);
export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
