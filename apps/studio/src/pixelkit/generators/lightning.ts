/* Pixelkit generator: Lightning (effect).
   Bolts come out of the cloud base: the channel starts faint inside the cloud and runs down from it, and each flash
   lights the cloud around where the bolt leaves it, on top of the sky flash.
   A plain ES module. Change anything; the studio and CLI only rely on the contract in @pixelkit/core types. */
import {
  bay,
  type Color,
  defineGenerator,
  mulberry32,
  param,
  type RenderContext,
  type TimedEvent,
} from "../core/index.ts";

/** How far up into the cloud the channel shows, fading out, in pixels. */
const IN_CLOUD = 6;
const GLOW_STEPS = 3;

/** Light inside the cloud around the bolt's origin (x0, y0): a wide ellipse in dithered steps, brightest at the origin. */
function cloudGlow(
  c: RenderContext,
  x0: number,
  y0: number,
  col: Color,
  a: number
): void {
  const rx = Math.max(8, Math.round(c.W * 0.09));
  const ry = Math.max(4, Math.round(c.H * 0.06));
  for (let y = Math.max(0, y0 - ry); y <= y0 + ry; y++) {
    const fy = (y - y0) / ry;
    for (let dx = -rx; dx <= rx; dx++) {
      const fx = dx / rx;
      const d = 1 - (fx * fx + fy * fy);
      if (d > 0) {
        // three flat steps with ordered dither between them, like the rest of the art
        const step = Math.floor(d * d * GLOW_STEPS + bay(x0 + dx, y));
        if (step > 0) {
          c.glow(x0 + dx, y, col, (a * step) / GLOW_STEPS);
        }
      }
    }
  }
}

/** Strike brightness l seconds into a strike: flash, dip, re-strike, fade. */
function strikeIntensity(l: number): number {
  if (l < 0.06) {
    return 1;
  }
  if (l < 0.12) {
    return 0.15;
  }
  if (l < 0.2) {
    return 0.85;
  }
  if (l < 0.26) {
    return 0.1;
  }
  return 0.35 * (1 - (l - 0.26) / 0.14);
}

export default defineGenerator("lightning", {
  blend: "add",
  kind: "effect",
  label: "Lightning",
  parallax: 0,
  params: {
    base: param.range("Cloud base", 0, 0.6, 0.2),
    branches: param.range("Branching", 0, 1, 0.5, { step: 0.05 }),
    color: param.color("Color", "#dfe8ff"),
    flash: param.range("Sky flash", 0, 1, 0.5, { step: 0.05 }),
    rate: param.range("Strikes / 10s", 0, 10, 2.5, { step: 0.5 }),
    reach: param.range("Reach", 0.2, 1, 0.75),
  },
  render(c) {
    if (c.p.rate > 0) {
      // a strike lasts 0.4 s and starts up to half a period late, so strikes do not keep a beat
      c.every(10 / c.p.rate, (strike) => drawStrike(c, strike), {
        duration: 0.4,
        jitter: 0.5,
      });
    }
  },
});

/** One strike, age seconds in: the sky flash, the lit cloud, and the bolt with its branches. */
function drawStrike(
  c: RenderContext<{
    color: Color;
    flash: number;
    branches: number;
    reach: number;
    base: number;
  }>,
  { index, age, rng }: TimedEvent
): void {
  const { W, H, p } = c;
  // branches draw from their own numbers, so more branching does not change the main channel
  const rb = mulberry32(c.seed * 57 + index * 104_729);
  const col = p.color;
  const I = strikeIntensity(age);
  if (p.flash > 0) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        c.plot(x + c.left, y, col, p.flash * 0.35 * I);
      }
    }
  }
  let x = Math.round(W * 0.15 + rng() * W * 0.7 + c.left);
  const y0 = Math.round(H * p.base);
  // the strike lights the cloud it comes from
  cloudGlow(c, x, y0, col, 0.45 * I);
  // the top of the channel, fading out up inside the cloud
  for (let up = 1; up <= Math.min(IN_CLOUD, y0); up++) {
    const a = I * 0.6 * (1 - up / (IN_CLOUD + 1));
    c.plot(x + (up % 3 === 0 ? -1 : 0), y0 - up, col, a);
  }
  let y = y0;
  const end = Math.max(H * p.reach, y0 + 8);
  while (y < end) {
    c.plot(x, y, col, I);
    c.plot(x + 1, y, col, I * 0.4);
    y += 1;
    x += Math.round((rng() - 0.5) * 2.4);
    if (rng() < p.branches * 0.08) {
      let bx = x,
        by = y;
      const dir = rb() < 0.5 ? -1 : 1,
        len = 5 + rb() * 14;
      for (let j = 0; j < len; j++) {
        bx += dir * (rb() < 0.6 ? 1 : 0);
        by += 1;
        c.plot(bx, by, col, I * 0.6);
      }
    }
  }
}
