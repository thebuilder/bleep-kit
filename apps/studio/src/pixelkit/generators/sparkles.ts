/* Pixelkit generator: Sparkles (effect).
   A plain ES module. Change anything; the studio and CLI only rely on the contract in @pixelkit/core types. */
import { defineGenerator, mulberry32, param } from "../core/index.ts";

export default defineGenerator("sparkles", {
  blend: "add",
  kind: "effect",
  label: "Sparkles",
  parallax: 0,
  params: {
    c1: param.color("Color A", "#ffffff"),
    c2: param.color("Color B", "#ffe07a"),
    count: param.range("Count", 0, 120, 25),
    h: param.range("Area height", 0, 1.2, 0.6),
    rate: param.range("Rate", 0.1, 4, 1, { step: 0.05 }),
    size: param.range("Size", 1, 3, 2),
    w: param.range("Area width", 0, 1.2, 0.8),
    x: param.range("Area X", 0, 1, 0.5),
    y: param.range("Area Y", 0, 1, 0.5),
  },
  render(c) {
    const { W, H, p, rng } = c;
    const A = p.c1,
      Bc = p.c2;
    for (let i = 0; i < c.density(p.count); i++) {
      const period = 1 / (p.rate * (0.6 + rng() * 0.8)),
        offset = rng();
      c.every(
        period,
        ({ index: n, progress: ph }) => {
          if (ph > 0.4) {
            return;
          }
          const r2 = mulberry32(c.seed * 97 + i * 131 + n * 7),
            x = c.screenX((p.x + (r2() - 0.5) * p.w) * W),
            y = (p.y + (r2() - 0.5) * p.h) * H,
            b = Math.sin((ph / 0.4) * Math.PI),
            col = i % 2 ? A : Bc;
          c.plot(x, y, col, b);
          if (p.size >= 2 && b > 0.5) {
            const arm = b > 0.85 && p.size >= 3 ? 2 : 1;
            for (let a = 1; a <= arm; a++) {
              c.plot(x + a, y, col, (b * 0.6) / a);
              c.plot(x - a, y, col, (b * 0.6) / a);
              c.plot(x, y + a, col, (b * 0.6) / a);
              c.plot(x, y - a, col, (b * 0.6) / a);
            }
          }
        },
        { offset, tol: 0.5 }
      );
    }
  },
});
