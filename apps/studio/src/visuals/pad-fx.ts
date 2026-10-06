/* What a sound tile does when it plays, shared by the pads and the examples view: the waveform thumbnail drawn from a
   render, and the layer on top of a grid of tiles where a played tile bursts (a flash, square rings, pixel particles)
   and a playhead sweeps across its thumbnail for as long as the sound lasts. */
import { hexToRgb, rgba, surface } from "./canvas.ts";

export const THUMB_W = 48;
export const THUMB_H = 22;

/** Draw the thumbnail of a render: `data` holds a (low, high) pair of peaks per pixel column, null draws the midline. */
export function drawThumb(
  canvas: HTMLCanvasElement,
  data: Float32Array | null,
  color: string
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.clearRect(0, 0, THUMB_W, THUMB_H);
  const mid = THUMB_H / 2;
  ctx.fillStyle = rgba(color, 0.22);
  ctx.fillRect(0, Math.floor(mid), THUMB_W, 1);
  if (!data) {
    return;
  }
  for (let x = 0; x < THUMB_W; x += 1) {
    const lo = data[x * 2] ?? 0;
    const hi = data[x * 2 + 1] ?? 0;
    const top = Math.round(mid - Math.min(1, hi * 1.6) * (mid - 1));
    const bot = Math.round(mid - Math.max(-1, lo * 1.6) * (mid - 1));
    ctx.fillStyle = color;
    ctx.fillRect(x, top, 1, Math.max(1, bot - top));
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillRect(x, top, 1, 1);
  }
}

interface Burst {
  at: number;
  big: boolean;
  color: string;
  rect: { x: number; y: number; w: number; h: number };
  seed: number;
}
const BURST_MS = 380;

/** The playhead that sweeps across a pad's waveform thumbnail while its sound plays. */
interface Sweep {
  at: number;
  color: string;
  ms: number;
  rect: { x: number; y: number; w: number; h: number };
}

export interface BurstLayer {
  /** A burst around `el` (a flash of the whole tile, rings, particles). */
  burst: (el: Element, color: string, big: boolean, now: number) => void;
  /** Drop what is on screen and release the canvas. */
  dispose: () => void;
  /** Draw the layer; call it every frame. */
  draw: (now: number) => void;
  /** Keep `el` lit (its `lit` class) until time `until`; `draw` puts it out. */
  light: (el: Element, until: number) => void;
  /** A playhead across `el` (a thumbnail) over `ms`. */
  sweep: (el: Element, color: string, ms: number, now: number) => void;
}

type Ctx = CanvasRenderingContext2D;

/** The part of a thumbnail already played brightens, and a hard 2 px playhead leads it. */
function drawSweep(c: Ctx, sw: Sweep, progress: number): void {
  const x = Math.round(sw.rect.x + progress * sw.rect.w);
  c.fillStyle = "rgba(255,255,255,0.16)";
  c.fillRect(sw.rect.x, sw.rect.y, x - sw.rect.x, sw.rect.h);
  c.fillStyle = rgba(sw.color, 0.35);
  c.fillRect(x - 4, sw.rect.y, 4, sw.rect.h);
  c.fillStyle = "#fff";
  c.fillRect(x - 1, sw.rect.y - 2, 2, sw.rect.h + 4);
}

/** A square ring around the tile's centre, snapped to a 4 px grid. */
function drawRing(
  c: Ctx,
  b: Burst,
  ring: { alpha: number; grow: number; thick: number },
  t: number
): void {
  const step = 4;
  const half = (b.rect.w / 2) * (0.55 + t * ring.grow);
  const sx = Math.round((b.rect.x + b.rect.w / 2 - half) / step) * step;
  const sy = Math.round((b.rect.y + b.rect.h / 2 - half) / step) * step;
  const size = Math.round((half * 2) / step) * step;
  const { thick } = ring;
  c.fillStyle = rgba(b.color, ring.alpha);
  c.fillRect(sx, sy, size, thick);
  c.fillRect(sx, sy + size - thick, size, thick);
  c.fillRect(sx, sy, thick, size);
  c.fillRect(sx + size - thick, sy, thick, size);
}

function drawParticles(c: Ctx, b: Burst, t: number): void {
  const n = b.big ? 18 : 12;
  const cx = b.rect.x + b.rect.w / 2;
  const cy = b.rect.y + b.rect.h / 2;
  const [r, g, bl] = hexToRgb(b.color);
  for (let k = 0; k < n; k += 1) {
    const ang = ((k + (b.seed % 5) * 0.13) / n) * Math.PI * 2;
    const dist = (b.rect.w * 0.3 + (k % 3) * 10) * (0.5 + t * 1.7);
    const px = Math.round((cx + Math.cos(ang) * dist) / 3) * 3;
    const py = Math.round((cy + Math.sin(ang) * dist + t * t * 22) / 3) * 3;
    c.fillStyle = `rgba(${r},${g},${bl},${Math.min(1, (1 - t) * 1.3)})`;
    const sz = k % 2 ? 4 : 8;
    c.fillRect(px, py, sz, sz);
  }
}

/** A flash of the whole tile, rings leaving it, pixel particles; `t` runs 0 to 1 over the burst. */
function drawBurst(c: Ctx, b: Burst, t: number): void {
  if (t < 0.4) {
    c.fillStyle = rgba(b.color, (1 - t / 0.4) ** 2 * 0.35);
    c.fillRect(b.rect.x, b.rect.y, b.rect.w, b.rect.h);
  }
  drawRing(c, b, { alpha: 1 - t, grow: 1.1, thick: t < 0.5 ? 6 : 3 }, t);
  if (t > 0.12) {
    drawRing(c, b, { alpha: (1 - t) * 0.5, grow: 0.85, thick: 3 }, t);
  }
  drawParticles(c, b, t);
}

/** Drop the entries of `list` that are over, and draw the rest (newest first, as the effects were drawn before). */
function drawLive<T>(
  list: T[],
  over: (item: T) => boolean,
  draw: (item: T) => void
): void {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i] as T;
    if (over(item)) {
      list.splice(i, 1);
    } else {
      draw(item);
    }
  }
}

/** The burst canvas on top of `wrap`, the element that holds the tiles (the canvas covers all of it, scrolled too). */
export function createBurstLayer(
  wrap: HTMLElement,
  burstCanvas: HTMLCanvasElement
): BurstLayer {
  const burstSurface = surface(burstCanvas);
  const bursts: Burst[] = [];
  const sweeps: Sweep[] = [];
  const lit = new Map<Element, number>();
  const rectIn = (el: Element, wr: DOMRect) => {
    const r = el.getBoundingClientRect();
    return { h: r.height, w: r.width, x: r.left - wr.left, y: r.top - wr.top };
  };
  function draw(now: number): void {
    for (const [el, until] of lit) {
      if (now > until) {
        el.classList.remove("lit");
        lit.delete(el);
      }
    }
    const { ctx: c } = burstSurface;
    if (wrap.scrollHeight !== burstCanvas.clientHeight) {
      burstCanvas.style.height = `${wrap.scrollHeight}px`;
      burstSurface.fit();
    }
    c.clearRect(0, 0, burstSurface.w, burstSurface.h);
    drawLive(
      sweeps,
      (sw) => now - sw.at > sw.ms,
      (sw) => drawSweep(c, sw, (now - sw.at) / sw.ms)
    );
    drawLive(
      bursts,
      (b) => now - b.at > BURST_MS,
      (b) => drawBurst(c, b, (now - b.at) / BURST_MS)
    );
  }

  return {
    burst(el, color, big, now) {
      bursts.push({
        at: now,
        big,
        color,
        rect: rectIn(el, wrap.getBoundingClientRect()),
        seed: Math.floor(now) % 97,
      });
    },
    dispose() {
      burstSurface.dispose();
      bursts.length = 0;
      sweeps.length = 0;
      lit.clear();
    },
    draw,
    light(el, until) {
      el.classList.add("lit");
      lit.set(el, until);
    },
    sweep(el, color, ms, now) {
      sweeps.push({
        at: now,
        color,
        ms,
        rect: rectIn(el, wrap.getBoundingClientRect()),
      });
    },
  };
}
