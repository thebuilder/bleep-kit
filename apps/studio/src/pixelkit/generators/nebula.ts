/* Pixelkit generator: Nebula (background).
   A plain ES module. Change anything; the studio and CLI only rely on the contract in @pixelkit/core types. */
import {
  bay,
  clamp01,
  defineGenerator,
  fbm2,
  hash2,
  mix,
  param,
  WHITE,
} from "../core/index.ts";

export default defineGenerator("nebula", {
  kind: "background",
  label: "Nebula",
  parallax: 0.02,
  params: {
    c1: param.color("Color A", "#6a2c8a"),
    c2: param.color("Color B", "#2a6a9a"),
    density: param.range("Density", 0, 1, 0.6, { step: 0.05 }),
    scale: param.range("Scale", 0.2, 3, 1, { step: 0.1 }),
    stars: param.range("Star dust", 0, 300, 80),
  },
  render(c) {
    const { W, H, p, seed, rng } = c;
    const A = p.c1,
      Bc = p.c2,
      s = 0.02 / p.scale;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const X = x + c.left;
        const n = fbm2(X * s, y * s * 1.3, seed, 4);
        const a = clamp01((n - 0.42) / 0.3) * p.density;
        const lv = Math.floor(a * 4 + bay(X, y)) / 4;
        if (lv <= 0) {
          continue;
        }
        const m = fbm2(X * s * 1.7 + 40, y * s * 1.7, seed + 5, 2);
        c.plot(X, y, mix(A, Bc, m), lv * 0.85);
        if (n > 0.62 && hash2(X, y, seed) < 0.04) {
          c.plot(X, y, WHITE, 0.8);
        }
      }
    }
    for (let i = 0; i < c.density(p.stars); i++) {
      c.plot(c.screenX(rng() * W), rng() * H, WHITE, 0.25 + rng() * 0.6);
    }
  },
});
