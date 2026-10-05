import { GLYPH_HEIGHT, GLYPH_WIDTH, glyphFor } from "./font.ts";
import type { PngImage } from "./png.ts";

export type Rgb = readonly [number, number, number];

function hex(color: string): Rgb {
  const n = Number.parseInt(color.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** The Pixelkit and Bleepkit studio tokens (architecture section 11.6). */
export const PALETTE = {
  accent: hex("#f3b24a"),
  bg: hex("#121119"),
  danger: hex("#e2766f"),
  fg: hex("#ece7da"),
  fm: hex("#f3b24a"),
  line: hex("#312f44"),
  muted: hex("#9a95ad"),
  noise: hex("#9a95ad"),
  panel: hex("#1a1924"),
  pulse: hex("#7d97dc"),
  raised: hex("#242332"),
  sample: hex("#e2766f"),
  sid: hex("#b49ae6"),
  triangle: hex("#74c08f"),
  wave: hex("#dc7ba4"),
} as const;

/** Glyph advance and line height for a font scale. */
export function cellWidth(scale: number): number {
  return (GLYPH_WIDTH + 1) * scale;
}

export function lineHeight(scale: number): number {
  return (GLYPH_HEIGHT + 1) * scale;
}

export function textWidth(text: string, scale: number): number {
  return text.length === 0 ? 0 : text.length * cellWidth(scale) - scale;
}

/** An RGBA pixel buffer with the few drawing primitives the charts need. Everything clips to the image. */
export class Canvas {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number, background: Rgb = PALETTE.bg) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
    this.rect(0, 0, width, height, background);
  }

  /** Blend one pixel; alpha is 0 to 1. */
  px(x: number, y: number, color: Rgb, alpha = 1): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return;
    }
    const i = (y * this.width + x) * 4;
    const d = this.data;
    if (alpha >= 1) {
      d[i] = color[0];
      d[i + 1] = color[1];
      d[i + 2] = color[2];
    } else {
      d[i] = Math.round((d[i] ?? 0) * (1 - alpha) + color[0] * alpha);
      d[i + 1] = Math.round((d[i + 1] ?? 0) * (1 - alpha) + color[1] * alpha);
      d[i + 2] = Math.round((d[i + 2] ?? 0) * (1 - alpha) + color[2] * alpha);
    }
    d[i + 3] = 255;
  }

  rect(
    x: number,
    y: number,
    w: number,
    h: number,
    color: Rgb,
    alpha = 1
  ): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let yy = y0; yy < y1; yy += 1) {
      for (let xx = x0; xx < x1; xx += 1) {
        this.px(xx, yy, color, alpha);
      }
    }
  }

  /** A 1 px outline of a rectangle. */
  frame(
    x: number,
    y: number,
    w: number,
    h: number,
    color: Rgb,
    alpha = 1
  ): void {
    this.rect(x, y, w, 1, color, alpha);
    this.rect(x, y + h - 1, w, 1, color, alpha);
    this.rect(x, y, 1, h, color, alpha);
    this.rect(x + w - 1, y, 1, h, color, alpha);
  }

  /** A vertical line from y0 to y1 (inclusive), optionally dashed. */
  vline(
    x: number,
    y0: number,
    y1: number,
    color: Rgb,
    alpha = 1,
    dash = 0
  ): void {
    const top = Math.round(Math.min(y0, y1));
    const bottom = Math.round(Math.max(y0, y1));
    for (let y = top; y <= bottom; y += 1) {
      if (dash === 0 || Math.floor((y - top) / dash) % 2 === 0) {
        this.px(Math.round(x), y, color, alpha);
      }
    }
  }

  hline(
    y: number,
    x0: number,
    x1: number,
    color: Rgb,
    alpha = 1,
    dash = 0
  ): void {
    const left = Math.round(Math.min(x0, x1));
    const right = Math.round(Math.max(x0, x1));
    for (let x = left; x <= right; x += 1) {
      if (dash === 0 || Math.floor((x - left) / dash) % 2 === 0) {
        this.px(x, Math.round(y), color, alpha);
      }
    }
  }

  /** A line of the given thickness (Bresenham with a square brush). */
  line(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: Rgb,
    thickness = 1,
    alpha = 1
  ): void {
    let x = Math.round(x0);
    let y = Math.round(y0);
    const xe = Math.round(x1);
    const ye = Math.round(y1);
    const dx = Math.abs(xe - x);
    const dy = -Math.abs(ye - y);
    const sx = x < xe ? 1 : -1;
    const sy = y < ye ? 1 : -1;
    let err = dx + dy;
    const half = Math.floor((thickness - 1) / 2);
    for (;;) {
      this.rect(x - half, y - half, thickness, thickness, color, alpha);
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

  /** Draw text with its top left at (x, y). Returns the width drawn. */
  text(
    text: string,
    x: number,
    y: number,
    color: Rgb,
    scale = 2,
    alpha = 1
  ): number {
    let cursor = x;
    for (const ch of text) {
      const rows = glyphFor(ch);
      for (let r = 0; r < GLYPH_HEIGHT; r += 1) {
        const bits = rows[r] ?? 0;
        for (let c = 0; c < GLYPH_WIDTH; c += 1) {
          if ((bits >> (GLYPH_WIDTH - 1 - c)) & 1) {
            this.rect(
              cursor + c * scale,
              y + r * scale,
              scale,
              scale,
              color,
              alpha
            );
          }
        }
      }
      cursor += cellWidth(scale);
    }
    return cursor - x - scale;
  }

  /** Text right aligned so that it ends at x. */
  textRight(
    text: string,
    x: number,
    y: number,
    color: Rgb,
    scale = 2,
    alpha = 1
  ): void {
    this.text(text, x - textWidth(text, scale), y, color, scale, alpha);
  }

  /** Text centered on x. */
  textCenter(
    text: string,
    x: number,
    y: number,
    color: Rgb,
    scale = 2,
    alpha = 1
  ): void {
    this.text(
      text,
      Math.round(x - textWidth(text, scale) / 2),
      y,
      color,
      scale,
      alpha
    );
  }

  toImage(): PngImage {
    return { data: this.data, height: this.height, width: this.width };
  }
}
