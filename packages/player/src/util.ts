/** Drop keys whose value is undefined, so the result fits `exactOptionalPropertyTypes` targets. */
export function defined<T extends object>(
  obj: T
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
