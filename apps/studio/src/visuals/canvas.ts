/* Canvas helpers: a canvas that tracks its CSS size at devicePixelRatio, drawn in CSS pixels. */

export interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  dispose: () => void;
  dpr: number;
  /** Resize now (called by the observer, and by tests). */
  fit: () => void;
  h: number;
  /** CSS size */
  w: number;
}

export function surface(
  canvas: HTMLCanvasElement,
  opts: { pixelScale?: number } = {}
): Surface {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("no 2d context");
  }
  const s: Surface = {
    canvas,
    ctx,
    dispose() {
      ro?.disconnect();
    },
    dpr: 1,
    fit() {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.max(
        1,
        Math.round((globalThis.devicePixelRatio || 1) * (opts.pixelScale ?? 1))
      );
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      if (w !== s.w || h !== s.h || dpr !== s.dpr || canvas.width !== w * dpr) {
        s.w = w;
        s.h = h;
        s.dpr = dpr;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
    },
    h: 0,
    w: 0,
  };
  const ro =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => s.fit());
  ro?.observe(canvas);
  s.fit();
  return s;
}

/** Rising zero crossing: the start index for a scope that stands still. */
export function triggerIndex(buf: Float32Array, window: number): number {
  const limit = buf.length - window;
  for (let i = 1; i < limit; i += 1) {
    if ((buf[i - 1] ?? 0) <= 0 && (buf[i] ?? 0) > 0) {
      return i;
    }
  }
  return 0;
}

/**
 * The trace of `win` samples of `data` from `start`, squeezed into `w` pixel columns on a canvas `h` tall. Full scale
 * lands 2 px from the top and bottom edge, and each column reaches back to the row the column before it ended on, so
 * a steep edge draws as a line and not as dots. `spans` holds a top and a bottom row for each column, `peak` the
 * loudest sample shown (0..1).
 */
export function scopeTrace(
  data: Float32Array,
  start: number,
  win: number,
  w: number,
  h: number
): { peak: number; spans: Int32Array } {
  return traceColumns(
    w,
    h,
    (x) => data[start + Math.floor((x / w) * win)] ?? 0
  );
}

/**
 * The columns of a trace for a wave read through `sampleAtColumn(x)`, clamped to full scale: the rows the trace
 * covers in each of `w` columns on a canvas `h` tall (see scopeTrace), and the loudest sample shown.
 */
export function traceColumns(
  w: number,
  h: number,
  sampleAtColumn: (x: number) => number
): { peak: number; spans: Int32Array } {
  const mid = h / 2;
  const spans = new Int32Array(w * 2);
  let prevY = mid;
  let peak = 0;
  for (let x = 0; x < w; x += 1) {
    const v = Math.min(1, Math.max(-1, sampleAtColumn(x)));
    peak = Math.max(peak, Math.abs(v));
    const y = Math.round(mid - v * (mid - 2));
    spans[x * 2] = Math.min(y, prevY);
    spans[x * 2 + 1] = Math.max(y, prevY);
    prevY = y;
  }
  return { peak, spans };
}

export function rms(buf: Float32Array): number {
  let s = 0;
  for (const v of buf) {
    s += v * v;
  }
  return Math.sqrt(s / Math.max(1, buf.length));
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}
export const rgba = (hex: string, a: number): string => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};
