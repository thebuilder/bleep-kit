/* Pixelkit generator: Sky (background).
   A plain ES module. Change anything; the studio and CLI only rely on the contract in @pixelkit/core types. */
import {
  bay,
  type Color,
  clamp01,
  defineGenerator,
  fbm2,
  hash2,
  mix,
  mod,
  param,
  type RenderContext,
  TAU,
} from "../core/index.ts";

const METEOR_SECONDS = 0.9;
/** A shooting star u (0 to 1) of the way through its flight from (x0, y0), heading left (dir -1) or right. */
function streak(
  c: RenderContext,
  x0: number,
  y0: number,
  u: number,
  dir: number,
  col: Color
): void {
  const len = 22;
  const head = u * len * 1.6;
  const fade = u < 0.7 ? 1 : (1 - u) / 0.3;
  for (let k = 0; k < 9; k++) {
    const d = head - k;
    if (d < 0) {
      break;
    }
    c.plot(x0 + dir * d, y0 + d * 0.45, col, fade * (1 - k / 9));
  }
}
/**
 * Shooting stars a minute at seeded places in the upper sky. Each scene-width tile of the world has its own schedule,
 * so a wider view gets more of them and a streak crossing into the next tile is drawn whole. In a loop they come at a
 * whole number per loop (none when the loop is shorter than the gap between them), so the loop stays seamless.
 */
function meteors(c: RenderContext, perMinute: number, col: Color): void {
  let slot = 60 / perMinute;
  if (c.loop) {
    const n = Math.round((c.loop * perMinute) / 60);
    if (!n) {
      return;
    }
    slot = c.loop / n;
  }
  c.tiles(48, (_r, bx, tile) => {
    const shifted = c.t + hash2(tile, 9, c.seed) * slot;
    const tt = c.loop ? mod(shifted, c.loop) : shifted;
    const k = Math.floor(tt / slot);
    const age = tt - k * slot;
    if (age < METEOR_SECONDS) {
      const x0 = bx + hash2(k, tile * 3 + 1, c.seed) * c.W;
      const y0 = (0.05 + hash2(k, tile * 3 + 2, c.seed) * 0.35) * c.H;
      const dir = hash2(k, tile * 3 + 3, c.seed) < 0.5 ? -1 : 1;
      streak(c, x0, y0, age / METEOR_SECONDS, dir, col);
    }
  });
}

export default defineGenerator("sky", {
  fit: "extend",
  kind: "background",
  label: "Sky",
  parallax: 0,
  params: {
    bands: param.range("Bands", 2, 16, 6),
    bottom: param.color("Horizon", "#5b4a7a"),
    meteors: param.range("Shooting stars a minute", 0, 30, 0),
    mid: param.color("Middle", "#8a4a6a"),
    stars: param.range("Stars", 0, 250, 60),
    style: param.select(
      "Style",
      ["gradient", "sunset", "overcast"],
      "gradient"
    ),
    top: param.color("Top", "#1b1a3a"),
    twinkle: param.range("Twinkle", 0, 1, 0.5, { step: 0.05 }),
  },
  render(c) {
    const { W, H, p, rng } = c;
    const St: Color = [255, 248, 230];
    for (let i = 0; i < p.stars; i++) {
      const x = c.screenX(rng() * W),
        y = rng() * H * 0.65,
        ph = rng() * TAU,
        big = rng() < 0.12;
      const b = 1 - p.twinkle * (0.5 + 0.5 * c.wave(2.5, ph));
      c.plot(x, y, St, b);
      if (big && b > 0.7) {
        c.plot(x + 1, y, St, b * 0.45);
        c.plot(x - 1, y, St, b * 0.45);
        c.plot(x, y + 1, St, b * 0.45);
        c.plot(x, y - 1, St, b * 0.45);
      }
    }
    if (p.meteors > 0) {
      meteors(c, p.meteors, St);
    }
    // a tap on the sky sends a shooting star from where it landed
    for (const e of c.taps) {
      if (e.hit && e.age < METEOR_SECONDS) {
        streak(
          c,
          e.x,
          e.y,
          e.age / METEOR_SECONDS,
          e.x > c.view.left + c.view.w / 2 ? -1 : 1,
          St
        );
      }
    }
  },
  renderStatic(c) {
    const { W, H, p, seed } = c;
    const A = p.top,
      M = p.mid,
      Bc = p.bottom,
      n = p.bands;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const X = x + c.left;
        let f = y / (H - 1);
        if (p.style === "overcast") {
          f = clamp01(f + (fbm2(X * 0.03, y * 0.07, seed, 3) - 0.5) * 0.6);
        }
        const lv =
          Math.min(n - 1, Math.floor(f * (n - 1) + bay(X, y))) / (n - 1);
        let col: Color;
        if (p.style !== "sunset") {
          col = mix(A, Bc, lv);
        } else if (lv < 0.5) {
          col = mix(A, M, lv * 2);
        } else {
          col = mix(M, Bc, (lv - 0.5) * 2);
        }
        c.plot(X, y, col, 1);
      }
    }
  },
});
