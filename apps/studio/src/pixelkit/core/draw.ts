/* Drawing helpers. They take the render context and world coordinates (they draw through c.plot). line, rect, density,
   tiles and repeatX are on the context too (c.line, c.tiles, ...); field and blob are for shapes and fields. */
import { bay, hash2, mulberry32 } from "./math.ts";
import type { BlobOptions, Circle, Color, RenderContext } from "./types.ts";

type Ctx = RenderContext<unknown>;
type Plotter = Pick<Ctx, "plot">;

/** Bresenham line, th pixels thick (thickness grows to the right). */
export function line(
  c: Plotter,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  col: Color,
  a = 1,
  th = 1
): void {
  let x = Math.round(x0),
    y = Math.round(y0);
  const xe = Math.round(x1),
    ye = Math.round(y1);
  const dx = Math.abs(xe - x),
    sx = x < xe ? 1 : -1,
    dy = -Math.abs(ye - y),
    sy = y < ye ? 1 : -1;
  let err = dx + dy;
  const steps = Math.min(8192, Math.max(dx, -dy) + 1);
  for (let n = 0; n < steps; n++) {
    for (let k = 0; k < th; k++) {
      c.plot(x + k, y, col, a);
    }
    if (x === xe && y === ye) {
      break;
    }
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}
/**
 * A particle count scaled to the area this layer covers: n at the scene's own size, more when a stretched layer covers a
 * larger view, so rain or dust keeps its density on a wide page. Exactly n when the view is the scene's size.
 */
export function density(
  c: { W: number; H: number; scene: { w: number; h: number } },
  n: number
): number {
  return c.W === c.scene.w && c.H === c.scene.h
    ? n
    : (n * c.W * c.H) / (c.scene.w * c.scene.h);
}
/** Filled rectangle. */
export function rect(
  c: Plotter,
  x: number,
  y: number,
  w: number,
  h: number,
  col: Color,
  a = 1
): void {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      c.plot(x + i, y + j, col, a);
    }
  }
}
/**
 * Repeat scattered objects per screen-width tile so parallax scrolling never runs out.
 * fn(rng, tileStartX, tileIndex) is called for every tile that can be visible; place objects at tileStartX + rng()*c.W.
 * margin must cover how far an object can reach outside its own tile, or it pops in at tile edges while panning.
 * period > 0 makes the pattern repeat every `period` tiles (needed when content drifts and must loop seamlessly).
 */
export function tiles(
  c: Pick<Ctx, "W" | "left" | "seed">,
  margin: number,
  fn: (rng: () => number, tileStartX: number, tileIndex: number) => void,
  shift = 0,
  period = 0
): void {
  const { W } = c;
  const a = c.left - shift - margin;
  const b = c.left - shift + W + margin;
  for (let k = Math.floor(a / W); k <= Math.floor(b / W); k++) {
    const kk = period > 0 ? ((k % period) + period) % period : k;
    fn(mulberry32((c.seed * 7919 + kk * 104_729) | 0), k * W + shift, k);
  }
}
/**
 * Draw a single placed object (a sun, a fire, a portal) at world x, repeated every screen width so it scrolls with the
 * layer's parallax and comes back around like tiled content. fn(worldX) is called for each copy that can be visible.
 * margin is how far the object reaches past its x.
 */
export function repeatX(
  c: Pick<Ctx, "W" | "left">,
  x: number,
  margin: number,
  fn: (worldX: number) => void
): void {
  const { W } = c;
  for (
    let k = Math.ceil((c.left - margin - x) / W);
    k <= Math.floor((c.left + W + margin - x) / W);
    k++
  ) {
    fn(x + k * W);
  }
}
/** Smooth field sampled on a coarse grid and interpolated. Cuts noise cost by cell^2. Returns (X, y) => value. Points outside the screen are computed directly. */
export function field(
  c: Pick<Ctx, "W" | "H" | "left">,
  cell: number,
  fn: (x: number, y: number) => number
): (X: number, y: number) => number {
  const cw = Math.ceil(c.W / cell) + 3,
    ch = Math.ceil(c.H / cell) + 3,
    m = new Float32Array(cw * ch).fill(Number.NaN);
  const ox = Math.floor((c.left || 0) / cell);
  const at = (i: number, j: number): number => {
    const ci = i - ox;
    if (ci < 0 || ci >= cw || j < 0 || j >= ch) {
      return fn(i * cell, j * cell);
    }
    const k = j * cw + ci;
    let v = m[k] ?? Number.NaN;
    if (Number.isNaN(v)) {
      v = fn(i * cell, j * cell);
      m[k] = v;
    }
    return v;
  };
  return (X, y) => {
    const fx = X / cell,
      fy = Math.max(0, y) / cell,
      i = Math.floor(fx),
      j = Math.floor(fy),
      u = fx - i,
      v = fy - j;
    const a = at(i, j),
      b = at(i + 1, j),
      cc = at(i, j + 1),
      d = at(i + 1, j + 1);
    return a + (b - a) * u + (cc - a) * v + (a - b - cc + d) * u * v;
  };
}
/**
 * Union of circles with a flat bottom, shaded light on top, shade low and bottom-right. Used for canopies, bushes, clouds, boulders.
 * Returns inside(x, y).
 */
/**
 * A soft round puff of smoke or dust: the pixels within r of (x, y) where the dither threshold is below fill, which thins
 * toward the edge (fill 1 is solid in the middle and half covered at the rim).
 */
export function puff(
  c: Plotter,
  x: number,
  y: number,
  r: number,
  fill: number,
  col: Color,
  a = 1
): void {
  for (let dy = -Math.ceil(r); dy <= r; dy++) {
    for (let dx = -Math.ceil(r); dx <= r; dx++) {
      const d = Math.hypot(dx, dy) / r;
      if (
        d <= 1 &&
        bay(Math.round(x + dx), Math.round(y + dy)) < fill * (1 - d * 0.5)
      ) {
        c.plot(x + dx, y + dy, col, a);
      }
    }
  }
}
export function blob(
  c: Plotter,
  circles: readonly Circle[],
  bottom: number,
  L: Color,
  M: Color,
  Sd: Color,
  opts: BlobOptions = {}
): (x: number, y: number) => boolean {
  const sq = opts.squash || 1;
  let x0 = 1e9;
  let x1 = -1e9;
  let y0 = 1e9;
  for (const q of circles) {
    x0 = Math.min(x0, q.x - q.r);
    x1 = Math.max(x1, q.x + q.r);
    y0 = Math.min(y0, q.y - q.r * Math.max(1, sq));
  }
  const inside = (x: number, y: number): boolean =>
    y <= bottom &&
    circles.some((q) => {
      const dx = x - q.x;
      const dy = (y - q.y) / sq;
      return dx * dx + dy * dy <= q.r * q.r;
    });
  const mid = (y0 + bottom) / 2;
  const shade = (x: number, y: number): Color => {
    const top = !(inside(x, y - 1) && inside(x - 1, y - 1));
    const low = y > mid + (bay(x, y) - 0.5) * 4 + (opts.lowBias || 0);
    let col = M;
    if (top) {
      col = L;
    } else if (low || !inside(x + 1, y + 1)) {
      col = Sd;
    }
    if (opts.tex && hash2(x, y, opts.seed || 1) < opts.tex) {
      col = Sd;
    }
    return opts.dot?.(x, y, top, low) || col;
  };
  for (let y = Math.floor(y0 - 1); y <= bottom; y++) {
    for (let x = Math.floor(x0 - 1); x <= Math.ceil(x1 + 1); x++) {
      if (inside(x, y)) {
        c.plot(x, y, shade(x, y), 1);
      }
    }
  }
  return inside;
}
