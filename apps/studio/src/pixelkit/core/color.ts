/* Colors are [r, g, b] tuples (0..255). Params store colors as '#rrggbb' strings; convert with rgb().
   rgb() returns shared frozen tuples: copy one before changing it (mix() always returns a new one). */
import type { Color } from "./types.ts";

const RGBC = new Map<unknown, Color>();
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
export const BLACK: Color = Object.freeze([0, 0, 0] as const);
export const WHITE: Color = Object.freeze([255, 255, 255] as const);
/** '#rrggbb' or '#rgb' to [r, g, b], cached. Anything else is black. */
export function rgb(h: unknown): Color {
  const cached = RGBC.get(h);
  if (cached) {
    return cached;
  }
  const m = typeof h === "string" ? HEX.exec(h) : null;
  if (!m?.[1]) {
    return BLACK;
  }
  const hex = m[1].length === 3 ? [...m[1]].map((x) => x + x).join("") : m[1];
  const n = Number.parseInt(hex, 16);
  const c: Color = Object.freeze([
    (n >> 16) & 255,
    (n >> 8) & 255,
    n & 255,
  ] as const);
  RGBC.set(h, c);
  return c;
}
/** Linear blend of two colors, f = 0 gives a, f = 1 gives b. */
export const mix = (a: Color, b: Color, f: number): Color => [
  a[0] + (b[0] - a[0]) * f,
  a[1] + (b[1] - a[1]) * f,
  a[2] + (b[2] - a[2]) * f,
];
