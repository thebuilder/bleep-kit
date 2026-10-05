/* Small seeded-random helpers shared by every generator. All randomness comes from a mulberry32 stream. */

export type Rng = () => number;

export function between(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

/** Integer in lo..hi inclusive. */
export function intBetween(rng: Rng, lo: number, hi: number): number {
  return Math.floor(between(rng, lo, hi + 1));
}

/** Log-uniform value between lo and hi (both > 0). */
export function logBetween(rng: Rng, lo: number, hi: number): number {
  return lo * (hi / lo) ** rng();
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}

export function weighted<T>(
  rng: Rng,
  entries: readonly (readonly [T, number])[]
): T {
  let total = 0;
  for (const [, w] of entries) {
    total += w;
  }
  let at = rng() * total;
  for (const [value, w] of entries) {
    at -= w;
    if (at < 0) {
      return value;
    }
  }
  return (entries.at(-1) as readonly [T, number])[0];
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Round to a number of decimals, without producing -0. */
export function round(v: number, decimals = 3): number {
  const k = 10 ** decimals;
  const out = Math.round(v * k) / k;
  return out === 0 ? 0 : out;
}

/** Roughly normal value from three uniform draws (cheap, bounded to about +-3). */
export function gauss(rng: Rng): number {
  return (rng() + rng() + rng() - 1.5) * 2;
}

/** Deep copy of a plain JSON document (the runtime has no DOM, so no structuredClone in the type libs). */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
