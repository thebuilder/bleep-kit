// biome-ignore-all lint/suspicious/noBitwiseOperators: integer hashing needs bitwise operators
// biome-ignore-all lint/style/useShorthandAssign: the mulberry32 mix is kept in its canonical form
/* Seeded randomness. Everything random in Bleepkit goes through here: Math.random is banned in core, sfx and player. */

/** mulberry32: a small, fast 32-bit PRNG. Returns floats in [0, 1). Identical to Pixelkit's. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** FNV-1a, 32 bit, over the UTF-16 code units of the string. Turns ids into seeds. */
export function hashString(s: string): number {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01_00_01_93);
  }
  return h >>> 0;
}

/** A child seed of `seed`, stable for the same (seed, salt) pair and well spread across salts. */
export function deriveSeed(seed: number, salt: number | string): number {
  const s = typeof salt === "number" ? salt | 0 : hashString(salt) | 0;
  let h = Math.imul((seed | 0) ^ 0x9e_37_79_b9, 0x85_eb_ca_6b) ^ s;
  h = Math.imul(h ^ (h >>> 16), 0x85_eb_ca_6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2_b2_ae_35);
  h ^= h >>> 16;
  return h >>> 0;
}
